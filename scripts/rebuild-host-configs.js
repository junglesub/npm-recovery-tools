#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";
import { Liquid } from "liquidjs";

const templates = {
	_header_comment: `# ------------------------------------------------------------
# {{ domain_names | join: ", " }}
# ------------------------------------------------------------
`,
	_hsts_map: `map $scheme $hsts_header {
    https   "max-age=63072000;{% if hsts_subdomains == 1 or hsts_subdomains == true -%} includeSubDomains;{% endif %} preload";
}
`,
	_listen: `  listen 80;
{% if ipv6 -%}
  listen [::]:80;
{% else -%}
  #listen [::]:80;
{% endif %}
{% if certificate -%}
  listen 443 ssl;
{% if ipv6 -%}
  listen [::]:443 ssl;
{% else -%}
  #listen [::]:443;
{% endif %}
{% endif %}
  server_name {{ domain_names | join: " " }};
{% if http2_support == 1 or http2_support == true %}
  http2 on;
{% else -%}
  http2 off;
{% endif %}
`,
	_certificates: `{% if certificate and certificate_id > 0 -%}
{% if certificate.provider == "letsencrypt" %}
  # Let's Encrypt SSL
  include conf.d/include/letsencrypt-acme-challenge.conf;
  include conf.d/include/ssl-cache.conf;
  include conf.d/include/ssl-ciphers.conf;
  ssl_certificate /etc/letsencrypt/live/npm-{{ certificate_id }}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/npm-{{ certificate_id }}/privkey.pem;
{% else %}
  # Custom SSL
  ssl_certificate /data/custom_ssl/npm-{{ certificate_id }}/fullchain.pem;
  ssl_certificate_key /data/custom_ssl/npm-{{ certificate_id }}/privkey.pem;
{% endif %}
{% endif %}
`,
	_assets: `{% if caching_enabled == 1 or caching_enabled == true -%}
  # Asset Caching
  include conf.d/include/assets.conf;
{% endif %}
`,
	_exploits: `{% if block_exploits == 1 or block_exploits == true %}
  # Block Exploits
  include conf.d/include/block-exploits.conf;
{% endif %}
`,
	_hsts: `{% if certificate and certificate_id > 0 -%}
{% if ssl_forced == 1 or ssl_forced == true %}
{% if hsts_enabled == 1 or hsts_enabled == true %}
  # HSTS (ngx_http_headers_module is required) (63072000 seconds = 2 years)
  add_header Strict-Transport-Security $hsts_header always;
{% endif %}
{% endif %}
{% endif %}
`,
	_forced_ssl: `{% if certificate and certificate_id > 0 -%}
{% if ssl_forced == 1 or ssl_forced == true %}
    # Force SSL
    {% if trust_forwarded_proto == true %}
    set $trust_forwarded_proto "T";
    {% else %}
    set $trust_forwarded_proto "F";
    {% endif %}
    include conf.d/include/force-ssl.conf;
{% endif %}
{% endif %}
`,
	_access: `{% if access_list_id > 0 %}
    {% if access_list.items.length > 0 %}
    # Authorization
    auth_basic            "Authorization required";
    auth_basic_user_file  /data/access/{{ access_list_id }};

    {% if access_list.pass_auth == 0 or access_list.pass_auth == false %}
    proxy_set_header Authorization "";
    {% endif %}

    {% endif %}

    # Access Rules: {{ access_list.clients | size }} total
    {% for client in access_list.clients %}
    {{client | nginxAccessRule}}
    {% endfor %}
    deny all;

    # Access checks must...
    {% if access_list.satisfy_any == 1 or access_list.satisfy_any == true %}
    satisfy any;
    {% else %}
    satisfy all;
    {% endif %}
{% endif %}
`,
	_location: `  location {{ path }} {
    {{ advanced_config }}

    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Scheme $scheme;
    proxy_set_header X-Forwarded-Proto  $scheme;
    proxy_set_header X-Forwarded-For    $remote_addr;
    proxy_set_header X-Real-IP\t\t$remote_addr;

    proxy_pass       {{ forward_scheme }}://{{ forward_host }}:{{ forward_port }}{{ forward_path }};

    {% include "_access" %}
    {% include "_assets" %}
    {% include "_exploits" %}
    {% include "_forced_ssl" %}
    {% include "_hsts" %}

    {% if allow_websocket_upgrade == 1 or allow_websocket_upgrade == true %}
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_http_version 1.1;
    {% endif %}
  }
`,
	proxy_host: `{% include "_header_comment" %}

{% if enabled %}

{% include "_hsts_map" %}

server {
  set $forward_scheme {{ forward_scheme }};
  set $server         "{{ forward_host }}";
  set $port           {{ forward_port }};

{% include "_listen" %}
{% include "_certificates" %}
{% include "_assets" %}
{% include "_exploits" %}
{% include "_hsts" %}
{% include "_forced_ssl" %}

{% if allow_websocket_upgrade == 1 or allow_websocket_upgrade == true %}
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $http_connection;
proxy_http_version 1.1;
{% endif %}

  access_log /data/logs/proxy-host-{{ id }}_access.log proxy;
  error_log /data/logs/proxy-host-{{ id }}_error.log warn;

{{ advanced_config }}

{{ locations }}

{% if use_default_location %}

  location / {

{% include "_access" %}
{% include "_hsts" %}

    {% if allow_websocket_upgrade == 1 or allow_websocket_upgrade == true %}
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_http_version 1.1;
    {% endif %}

    # Proxy!
    include conf.d/include/proxy.conf;
  }
{% endif %}

  # Custom
  include /data/nginx/custom/server_proxy[.]conf;
}
{% endif %}
`,
	redirection_host: `{% include "_header_comment" %}

{% if enabled %}

{% include "_hsts_map" %}

server {
{% include "_listen" %}
{% include "_certificates" %}
{% include "_assets" %}
{% include "_exploits" %}
{% include "_hsts" %}
{% include "_forced_ssl" %}

  access_log /data/logs/redirection-host-{{ id }}_access.log standard;
  error_log /data/logs/redirection-host-{{ id }}_error.log warn;

{{ advanced_config }}

{% if use_default_location %}
  location / {
{% include "_hsts" %}

    {% if preserve_path == 1 or preserve_path == true %}
        return {{ forward_http_code }} {{ forward_scheme }}://{{ forward_domain_name }}$request_uri;
    {% else %}
        return {{ forward_http_code }} {{ forward_scheme }}://{{ forward_domain_name }};
    {% endif %}
  }
{% endif %}

  # Custom
  include /data/nginx/custom/server_redirect[.]conf;
}
{% endif %}
`,
};

const usage = `Rebuild nginx proxy_host/redirection_host config files from database.sqlite

Usage:
  node ./scripts/rebuild-host-configs.js --db /path/to/database.sqlite [--output /path/to/nginx]

Options:
  --db       Path to database.sqlite. Defaults to ./database.sqlite
  --output   Path to the nginx root directory to recreate. Defaults to <db-dir>/nginx
  --dry-run  Render everything but do not write files
  --help     Show this help
`;

function parseArgs(argv) {
	const args = {
		db: path.resolve(process.cwd(), "database.sqlite"),
		output: null,
		dryRun: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		if (arg === "--help" || arg === "-h") {
			console.log(usage);
			process.exit(0);
		}

		if (arg === "--dry-run") {
			args.dryRun = true;
			continue;
		}

		if (arg === "--db") {
			args.db = path.resolve(argv[i + 1] || "");
			i += 1;
			continue;
		}

		if (arg === "--output") {
			args.output = path.resolve(argv[i + 1] || "");
			i += 1;
			continue;
		}

		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!args.output) {
		args.output = path.join(path.dirname(args.db), "nginx");
	}

	return args;
}

function ensureFileExists(filename, label) {
	if (!fs.existsSync(filename)) {
		throw new Error(`${label} not found: ${filename}`);
	}
}

function parseJson(value, fallback) {
	if (value === null || typeof value === "undefined" || value === "") {
		return fallback;
	}

	if (typeof value !== "string") {
		return value;
	}

	try {
		return JSON.parse(value);
	} catch {
		return fallback;
	}
}

function ipv6Enabled() {
	const disabled = `${process.env.DISABLE_IPV6 || ""}`.trim().toLowerCase();
	return !(disabled === "on" || disabled === "true" || disabled === "1" || disabled === "yes");
}

function advancedConfigHasDefaultLocation(config) {
	return /^(?:.*;)?\s*?location\s*?\/\s*?{/im.test(config || "");
}

function createRenderEngine() {
	const engine = new Liquid({
		fs: {
			readFile: async (file) => {
				if (!(file in templates)) {
					throw new Error(`Unknown inline template: ${file}`);
				}
				return templates[file];
			},
			readFileSync: (file) => {
				if (!(file in templates)) {
					throw new Error(`Unknown inline template: ${file}`);
				}
				return templates[file];
			},
			exists: async (file) => file in templates,
			existsSync: (file) => file in templates,
			resolve: (_root, file) => file,
			fallback: (_file) => "",
		},
	});

	engine.registerFilter("nginxAccessRule", (rule) => {
		if (rule?.directive && rule?.address) {
			return `${rule.directive} ${rule.address};`;
		}
		return "";
	});

	return engine;
}

function hasTable(db, tableName) {
	const row = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(tableName);
	return Boolean(row);
}

function getAllRows(db, tableName, extraWhere = "") {
	return db.prepare(`SELECT * FROM ${tableName} ${extraWhere}`).all();
}

function loadCertificates(db) {
	if (!hasTable(db, "certificate")) {
		return new Map();
	}

	return new Map(
		getAllRows(db, "certificate", "WHERE COALESCE(is_deleted, 0) = 0").map((row) => [
			row.id,
			{
				...row,
				domain_names: parseJson(row.domain_names, []),
				meta: parseJson(row.meta, {}),
			},
		]),
	);
}

function loadAccessLists(db) {
	if (!hasTable(db, "access_list")) {
		return new Map();
	}

	const accessLists = new Map(
		getAllRows(db, "access_list", "WHERE COALESCE(is_deleted, 0) = 0").map((row) => [
			row.id,
			{
				...row,
				meta: parseJson(row.meta, {}),
				satisfy_any: row.satisfy_any ?? row.satify_any ?? 0,
				pass_auth: row.pass_auth ?? 1,
				items: [],
				clients: [],
			},
		]),
	);

	if (hasTable(db, "access_list_auth")) {
		for (const row of getAllRows(db, "access_list_auth")) {
			const accessList = accessLists.get(row.access_list_id);
			if (accessList) {
				accessList.items.push({
					...row,
					meta: parseJson(row.meta, {}),
				});
			}
		}
	}

	if (hasTable(db, "access_list_client")) {
		for (const row of getAllRows(db, "access_list_client")) {
			const accessList = accessLists.get(row.access_list_id);
			if (accessList) {
				accessList.clients.push({
					...row,
					meta: parseJson(row.meta, {}),
				});
			}
		}
	}

	return accessLists;
}

async function renderLocations(engine, host) {
	const locations = Array.isArray(host.locations) ? host.locations : [];
	const template = templates._location;
	let rendered = "";

	for (const location of locations) {
		const locationCopy = {
			access_list_id: host.access_list_id,
			certificate_id: host.certificate_id,
			ssl_forced: host.ssl_forced,
			caching_enabled: host.caching_enabled,
			block_exploits: host.block_exploits,
			allow_websocket_upgrade: host.allow_websocket_upgrade,
			http2_support: host.http2_support,
			hsts_enabled: host.hsts_enabled,
			hsts_subdomains: host.hsts_subdomains,
			access_list: host.access_list,
			certificate: host.certificate,
			advanced_config: "",
			forward_scheme: "http",
			forward_host: "",
			forward_port: 80,
			forward_path: "",
			...location,
		};

		if (typeof locationCopy.forward_host === "string" && locationCopy.forward_host.includes("/")) {
			const splitHost = locationCopy.forward_host.split("/");
			locationCopy.forward_host = splitHost.shift() || "";
			locationCopy.forward_path = `/${splitHost.join("/")}`;
		}

		rendered += await engine.parseAndRender(template, locationCopy);
	}

	return rendered;
}

function normalizeProxyHost(row, certificates, accessLists) {
	const host = {
		...row,
		domain_names: parseJson(row.domain_names, []),
		meta: parseJson(row.meta, {}),
		locations: parseJson(row.locations, []),
		forward_host: row.forward_host ?? row.forward_ip ?? "",
		forward_scheme: row.forward_scheme ?? "http",
		advanced_config: row.advanced_config ?? "",
		access_list_id: row.access_list_id ?? 0,
		certificate_id: row.certificate_id ?? 0,
		ssl_forced: row.ssl_forced ?? 0,
		caching_enabled: row.caching_enabled ?? 0,
		block_exploits: row.block_exploits ?? 0,
		allow_websocket_upgrade: row.allow_websocket_upgrade ?? 0,
		http2_support: row.http2_support ?? 0,
		hsts_enabled: row.hsts_enabled ?? 0,
		hsts_subdomains: row.hsts_subdomains ?? 0,
		trust_forwarded_proto: row.trust_forwarded_proto ?? 0,
		enabled: row.enabled ?? 1,
		ipv6: ipv6Enabled(),
	};

	host.certificate = host.certificate_id > 0 ? certificates.get(host.certificate_id) || null : null;
	host.access_list =
		host.access_list_id > 0
			? accessLists.get(host.access_list_id) || { items: [], clients: [], satisfy_any: 0, pass_auth: 1 }
			: { items: [], clients: [], satisfy_any: 0, pass_auth: 1 };

	host.use_default_location = !advancedConfigHasDefaultLocation(host.advanced_config);
	if (Array.isArray(host.locations) && host.locations.some((location) => location?.path === "/")) {
		host.use_default_location = false;
	}

	return host;
}

function normalizeRedirectionHost(row, certificates) {
	const host = {
		...row,
		domain_names: parseJson(row.domain_names, []),
		meta: parseJson(row.meta, {}),
		advanced_config: row.advanced_config ?? "",
		certificate_id: row.certificate_id ?? 0,
		ssl_forced: row.ssl_forced ?? 0,
		block_exploits: row.block_exploits ?? 0,
		http2_support: row.http2_support ?? 0,
		hsts_enabled: row.hsts_enabled ?? 0,
		hsts_subdomains: row.hsts_subdomains ?? 0,
		preserve_path: row.preserve_path ?? 0,
		forward_scheme: row.forward_scheme ?? "auto",
		forward_http_code: row.forward_http_code ?? 302,
		enabled: row.enabled ?? 1,
		ipv6: ipv6Enabled(),
	};

	host.certificate = host.certificate_id > 0 ? certificates.get(host.certificate_id) || null : null;
	host.use_default_location = !advancedConfigHasDefaultLocation(host.advanced_config);

	if (!["http", "https"].includes(String(host.forward_scheme).toLowerCase())) {
		host.forward_scheme = "$scheme";
	}

	return host;
}

async function renderHostConfig(engine, hostType, host) {
	const template = templates[hostType];
	const renderInput = JSON.parse(JSON.stringify(host));

	if (hostType === "proxy_host") {
		renderInput.locations = await renderLocations(engine, renderInput);
	}

	return engine.parseAndRender(template, renderInput);
}

async function rebuildConfigs({ dbPath, outputRoot, dryRun }) {
	ensureFileExists(dbPath, "SQLite database");

	const engine = createRenderEngine();
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	const certificates = loadCertificates(db);
	const accessLists = loadAccessLists(db);

	const proxyDir = path.join(outputRoot, "proxy_host");
	const redirectDir = path.join(outputRoot, "redirection_host");

	if (!dryRun) {
		fs.mkdirSync(proxyDir, { recursive: true });
		fs.mkdirSync(redirectDir, { recursive: true });
	}

	const proxyRows = hasTable(db, "proxy_host")
		? getAllRows(db, "proxy_host", "WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(enabled, 1) = 1 ORDER BY id")
		: [];
	const redirectRows = hasTable(db, "redirection_host")
		? getAllRows(
				db,
				"redirection_host",
				"WHERE COALESCE(is_deleted, 0) = 0 AND COALESCE(enabled, 1) = 1 ORDER BY id",
			)
		: [];

	let proxyCount = 0;
	let redirectCount = 0;

	for (const row of proxyRows) {
		const host = normalizeProxyHost(row, certificates, accessLists);
		const rendered = await renderHostConfig(engine, "proxy_host", host);
		const filename = path.join(proxyDir, `${host.id}.conf`);

		if (!dryRun) {
			fs.writeFileSync(filename, rendered, "utf8");
		}

		proxyCount += 1;
		console.log(`${dryRun ? "[dry-run] would write" : "wrote"} ${filename}`);
	}

	for (const row of redirectRows) {
		const host = normalizeRedirectionHost(row, certificates);
		const rendered = await renderHostConfig(engine, "redirection_host", host);
		const filename = path.join(redirectDir, `${host.id}.conf`);

		if (!dryRun) {
			fs.writeFileSync(filename, rendered, "utf8");
		}

		redirectCount += 1;
		console.log(`${dryRun ? "[dry-run] would write" : "wrote"} ${filename}`);
	}

	db.close();

	console.log("");
	console.log(`proxy_host configs: ${proxyCount}`);
	console.log(`redirection_host configs: ${redirectCount}`);
	console.log(`output root: ${outputRoot}`);
}

async function main() {
	try {
		const args = parseArgs(process.argv.slice(2));
		await rebuildConfigs({
			dbPath: args.db,
			outputRoot: args.output,
			dryRun: args.dryRun,
		});
	} catch (error) {
		console.error(error.message);
		console.error("");
		console.error(usage);
		process.exit(1);
	}
}

await main();

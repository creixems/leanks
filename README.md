# Leanks

A self-hosted URL shortener with a [dub.co](https://dub.co)-style dashboard, built on top of
[YOURLS](https://yourls.org) so it runs on ordinary PHP/MySQL shared hosting -- no Node build
step, no Docker, no serverless platform required.

Leanks is YOURLS underneath (redirect engine, database, click tracking) with:

- A custom dashboard (vanilla HTML/CSS/JS, no framework) that looks and feels like a modern SaaS
  link manager instead of a classic PHP admin panel.
- **Password-protected links** -- require a password before a short link redirects.
- **Link expiration** -- by date, by max click count, or both.
- **UTM campaign tags** -- a built-in UTM builder with a live preview of the final destination URL.
- **QR codes** -- generated client-side for any link, downloadable as PNG.
- Click analytics (powered by YOURLS' own tracking): totals, a 30-day chart, top referrers, top
  countries.

## Why YOURLS underneath

YOURLS is plain PHP, MIT licensed, has no build step, and stores everything in a couple of MySQL
tables -- which makes it a good fit for cheap shared/cPanel hosting. Leanks keeps YOURLS' core
completely stock (redirect logic, database schema, click tracking, plugin API) and adds a small
plugin (`user/plugins/leanks`) plus an entirely custom front end (`app/`) on top, rather than
patching YOURLS' own files. That means YOURLS itself stays upgradeable in place.

The dashboard's visual design is inspired by dub.co -- studied and rebuilt from scratch in plain
CSS, not copied from their (closed-stack, Next.js/React/Tailwind) source, which shares nothing
with this project's vanilla PHP/JS stack.

## Requirements

- PHP 8.0+
- MySQL 5.7+ or MariaDB, with the `pdo_mysql` extension
- Apache with `mod_rewrite` (for pretty short URLs via `.htaccess`) -- other web servers work too,
  see [YOURLS' own docs](https://docs.yourls.org) for nginx/other rewrite rules

## Installing

1. Upload the contents of this repository to your web root (e.g. `public_html`), keeping the
   folder structure intact.
2. Visit `https://your-domain.com/setup/` in a browser and fill in your database details and an
   admin username/password. This writes `user/config.php`, creates the database tables, and
   activates the Leanks plugin automatically.
3. **Delete (or password-protect) the `/setup` folder once installed** -- it can rewrite your
   database credentials and shouldn't stay reachable.
4. Go to `https://your-domain.com/app/` and log in with the admin account you just created.

Prefer to configure by hand? Copy `user/config-sample.php` to `user/config.php`, fill in your
settings, then visit `/admin/install.php` (YOURLS' own installer) followed by `/admin/plugins.php`
to activate the "Leanks" plugin.

## Project layout

```
admin/                 Stock YOURLS admin (kept as a fallback/power-user UI)
app/                    The Leanks dashboard (vanilla HTML/CSS/JS)
  auth.php              Thin JSON bridge into YOURLS' own login/session
  index.html, login.html
  css/app.css            Design system (dub.co-inspired)
  js/app.js, api.js, login.js
  js/vendor/qrcode.js     Vendored QR code generator (MIT, see licenses/)
includes/               Stock YOURLS core (untouched)
setup/                  Web-based install wizard
user/
  config-sample.php      Manual-install config template
  plugins/leanks/         The plugin: password/expiration/UTM metadata + redirect gating
licenses/               Third-party license texts (YOURLS, qrcode.js)
```

## How the plugin works

Password protection, expiration and click limits are enforced by hooking YOURLS'
`redirect_shorturl` action (see `user/plugins/leanks/includes/redirect-gate.php`): before a click
is logged and redirected, Leanks checks a small metadata table (`{prefix}leanks_meta`, one row per
protected/expiring link) and can intercept the request with a password prompt or an "expired"
page. Everything else -- the redirect itself, click counting, referrer/geo logging -- is stock
YOURLS.

The dashboard talks to YOURLS' existing `admin-ajax.php` for link create/edit/delete (reusing its
built-in nonce-based CSRF protection and session auth), plus a handful of custom `leanks_*`
actions the plugin registers on the same endpoint for listing, stats, and metadata.

## Local development

No build step -- edit files and reload. To run it locally you need PHP and MySQL/MariaDB, e.g.:

```bash
php -S 127.0.0.1:8000 router.php   # see below for router.php
```

Since `php -S` doesn't read `.htaccess`, use a tiny router script that mirrors it for local testing:

```php
<?php
// router.php (dev only)
$root = $_SERVER['DOCUMENT_ROOT'];
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$file = $root . $path;
if ($path !== '/' && (is_file($file) || is_dir($file))) return false;
require $root . '/yourls-loader.php';
```

Then visit `http://127.0.0.1:8000/setup/` to install against your local database.

## License

MIT -- see [LICENSE](LICENSE). Bundles YOURLS and qrcode.js, both MIT licensed; see
[licenses/](licenses/) for their original license texts.

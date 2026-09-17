<?php
/**
 * Leanks setup wizard.
 *
 * Writes user/config.php from the form below, then bootstraps YOURLS to create its tables,
 * create the Leanks metadata table, and activate the Leanks plugin. Meant to replace YOURLS'
 * own "hand-edit config.php" install flow with something a cPanel user can click through.
 *
 * Delete or password-protect this /setup folder once you're done -- it can rewrite your config.
 */

$root = dirname( __DIR__ );
$config_path = $root . '/user/config.php';
$already_installed = file_exists( $config_path );

$errors = [];
$success = false;

function leanks_php_escape( $value ) {
    return str_replace( [ '\\', "'" ], [ '\\\\', "\\'" ], (string) $value );
}

function leanks_random_key( $length = 64 ) {
    return bin2hex( random_bytes( (int) ceil( $length / 2 ) ) );
}

/**
 * Turn the most common PDO connection failures into a message that says what to actually do,
 * instead of a raw driver error. "Access denied" in particular is almost always a shared-hosting
 * setup step, not a typo -- most hosts require the database and user to be created (and the user
 * granted access to that database) via the control panel before anything can connect.
 */
function leanks_setup_friendly_db_error( \Throwable $e ) {
    $msg = $e->getMessage();

    if ( stripos( $msg, 'Access denied' ) !== false ) {
        return "Access denied connecting to the database. On cPanel-style hosting this almost always means "
            . "the database and user exist but were never linked: go to MySQL Databases, use \"Add User to "
            . "Database\" to grant that user ALL PRIVILEGES on this database, and double-check the username -- "
            . "cPanel usually prefixes it with your account name (e.g. youraccount_dbuser), not just the short "
            . "name you typed when creating it. Original error: " . $msg;
    }

    if ( stripos( $msg, 'command denied' ) !== false ) {
        return "The database user is missing a privilege it needs to finish installing. In cPanel: MySQL "
            . "Databases -> Add User to Database -> make sure ALL PRIVILEGES is checked for this user on this "
            . "database, then submit this form again. Original error: " . $msg;
    }

    if ( stripos( $msg, 'Unknown database' ) !== false ) {
        return "That database doesn't exist and this user isn't allowed to create it (normal on shared "
            . "hosting). Create the database first via your host's control panel, then retry. Original error: " . $msg;
    }

    if ( stripos( $msg, 'could not find driver' ) !== false ) {
        return "The PHP pdo_mysql extension isn't available on this server -- ask your host to enable it. Original error: " . $msg;
    }

    return 'Could not connect to the database: ' . $msg;
}

/**
 * yourls_create_sql_tables() (stock YOURLS, includes/functions-install.php) returns only a
 * fixed set of plain-English messages with no further detail -- "Could not insert sample short
 * URLs" is a single bitwise-AND of three separate yourls_add_new_link() calls, with no way to
 * tell which one(s) actually failed or why. Find out for real: check which of the three fixed
 * sample keywords are missing, then retry just those through yourls_add_new_link() again to
 * capture its actual per-link message (already exists / reserved / DB error / etc) instead of
 * guessing at a single cause.
 */
function leanks_setup_diagnose_sample_links() {
    $samples = [
        'yourlsblog' => [ 'https://blog.yourls.org/', 'YOURLS\' Blog' ],
        'yourls'     => [ 'https://yourls.org/', 'YOURLS: Your Own URL Shortener' ],
        'ozh'        => [ 'https://ozh.org/', 'ozh.org' ],
    ];

    $table = YOURLS_DB_TABLE_URL;
    $existing = yourls_get_db( 'read-leanks_setup_diagnose' )->fetchAll(
        "SELECT `keyword` FROM `$table` WHERE `keyword` IN ('yourlsblog', 'yourls', 'ozh')"
    );
    $existing_keywords = array_column( $existing, 'keyword' );

    $reasons = [];
    foreach ( $samples as $keyword => [ $url, $title ] ) {
        if ( in_array( $keyword, $existing_keywords, true ) ) {
            continue;
        }
        $result = yourls_add_new_link( $url, $keyword, $title );
        $reasons[] = $keyword . ': ' . ( $result['message'] ?? 'unknown error' );
    }
    return $reasons;
}

function leanks_setup_friendly_install_error( $message ) {
    if ( $message === 'Could not insert sample short URLs' ) {
        $reasons = leanks_setup_diagnose_sample_links();
        if ( !empty( $reasons ) ) {
            return $message . ' -- ' . implode( '; ', $reasons );
        }
    }
    return $message;
}

$defaults = [
    'db_host'   => 'localhost',
    'db_name'   => '',
    'db_user'   => '',
    'db_pass'   => '',
    'db_prefix' => 'leanks_',
    'site_url'  => ( isset( $_SERVER['HTTPS'] ) && $_SERVER['HTTPS'] !== 'off' ? 'https://' : 'http://' ) . ( $_SERVER['HTTP_HOST'] ?? 'your-domain.com' ),
    'admin_user' => '',
    'admin_pass' => '',
    'cookie_key' => leanks_random_key(),
];

$values = $defaults;
if ( $_SERVER['REQUEST_METHOD'] === 'POST' ) {
    foreach ( $defaults as $key => $default ) {
        $values[ $key ] = isset( $_POST[ $key ] ) ? trim( (string) $_POST[ $key ] ) : $default;
    }
}

// Pre-flight checks
$checks = [
    'PHP 8.0 or newer'      => version_compare( PHP_VERSION, '8.0.0', '>=' ),
    'PDO MySQL extension'   => extension_loaded( 'pdo_mysql' ),
    'user/ directory writable' => is_writable( $root . '/user' ),
];

if ( $_SERVER['REQUEST_METHOD'] === 'POST' && !$already_installed ) {
    if ( in_array( false, $checks, true ) ) {
        $errors[] = 'One or more requirements above are not met. Fix those first.';
    }
    if ( $values['db_name'] === '' || $values['db_user'] === '' ) {
        $errors[] = 'Database name and user are required.';
    }
    if ( $values['admin_user'] === '' || $values['admin_pass'] === '' ) {
        $errors[] = 'Choose an admin username and password.';
    }
    if ( strlen( $values['admin_pass'] ) < 8 ) {
        $errors[] = 'Admin password should be at least 8 characters.';
    }
    if ( !preg_match( '/^[a-z0-9_]+$/i', $values['db_prefix'] ) ) {
        $errors[] = 'Table prefix can only contain letters, digits and underscores.';
    }

    // Test the DB connection before writing anything. Most cPanel-style hosts require the
    // database to be pre-created via the control panel (the DB user has no CREATE privilege),
    // so try connecting directly to it first and only attempt to create it as a fallback.
    if ( empty( $errors ) ) {
        $db_name_escaped = str_replace( '`', '', $values['db_name'] );

        // Support 'host:port', same convention as YOURLS_DB_HOST itself.
        $dsn_host = $values['db_host'];
        if ( strpos( $dsn_host, ':' ) !== false ) {
            [ $host_part, $port_part ] = explode( ':', $dsn_host, 2 );
            $dsn_host = sprintf( '%s;port=%d', $host_part, (int) $port_part );
        }

        try {
            $pdo = new PDO( 'mysql:host=' . $dsn_host . ';dbname=' . $db_name_escaped . ';charset=utf8mb4', $values['db_user'], $values['db_pass'] );
        } catch ( \PDOException $e ) {
            try {
                $pdo = new PDO( 'mysql:host=' . $dsn_host . ';charset=utf8mb4', $values['db_user'], $values['db_pass'] );
                $pdo->exec( 'CREATE DATABASE IF NOT EXISTS `' . $db_name_escaped . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin' );
            } catch ( \PDOException $e2 ) {
                $errors[] = leanks_setup_friendly_db_error( $e );
            }
        }

        // yourls_create_sql_tables() (stock YOURLS) assumes it's running against an empty
        // database and isn't written to be safely re-run -- initializing options or inserting the
        // fixed-keyword sample links both fail if that data already exists. This has to happen
        // now, before YOURLS bootstraps below and caches option values into memory: a truncate
        // done after that point wouldn't be reflected in what this request already cached, and
        // yourls_update_option() would wrongly think nothing changed. The only way to reach this
        // point with existing data is a previous attempt through this same wizard that got partway
        // through before failing later (it refuses to run at all once user/config.php exists), so
        // it's safe to clear these tables and let this attempt create everything fresh.
        // DELETE rather than TRUNCATE on purpose: TRUNCATE requires the DROP privilege (it's
        // implemented as a drop-and-recreate), which is easy to leave unchecked even when
        // granting otherwise-broad access in cPanel. DELETE only needs DELETE.
        if ( empty( $errors ) && isset( $pdo ) ) {
            foreach ( [ 'url', 'options', 'log' ] as $suffix ) {
                try {
                    $pdo->exec( 'DELETE FROM `' . $values['db_prefix'] . $suffix . '`' );
                } catch ( \PDOException $e ) {
                    // Table doesn't exist yet on a genuinely fresh database -- nothing to clean up.
                }
            }
        }
    }

    if ( empty( $errors ) ) {
        $config = "<?php\n"
            . "define( 'YOURLS_DB_USER', '" . leanks_php_escape( $values['db_user'] ) . "' );\n"
            . "define( 'YOURLS_DB_PASS', '" . leanks_php_escape( $values['db_pass'] ) . "' );\n"
            . "define( 'YOURLS_DB_NAME', '" . leanks_php_escape( $values['db_name'] ) . "' );\n"
            . "define( 'YOURLS_DB_HOST', '" . leanks_php_escape( $values['db_host'] ) . "' );\n"
            . "define( 'YOURLS_DB_PREFIX', '" . leanks_php_escape( $values['db_prefix'] ) . "' );\n"
            . "define( 'YOURLS_SITE', '" . leanks_php_escape( rtrim( $values['site_url'], '/' ) ) . "' );\n"
            . "define( 'YOURLS_LANG', '' );\n"
            . "define( 'YOURLS_UNIQUE_URLS', true );\n"
            . "define( 'YOURLS_PRIVATE', true );\n"
            . "define( 'YOURLS_COOKIEKEY', '" . leanks_php_escape( $values['cookie_key'] ) . "' );\n"
            . "\$yourls_user_passwords = [\n"
            . "    '" . leanks_php_escape( $values['admin_user'] ) . "' => '" . leanks_php_escape( $values['admin_pass'] ) . "',\n"
            . "];\n"
            . "define( 'YOURLS_URL_CONVERT', 36 );\n"
            . "define( 'YOURLS_DEBUG', false );\n"
            . "\$yourls_reserved_URL = [ 'admin', 'app', 'setup', 'api', 'stats' ];\n";

        if ( file_put_contents( $config_path, $config ) === false ) {
            $errors[] = 'Could not write user/config.php. Check folder permissions.';
        }
    }

    if ( empty( $errors ) ) {
        try {
            define( 'YOURLS_ADMIN', true );
            define( 'YOURLS_INSTALLING', true );
            require_once $root . '/includes/load-yourls.php';

            $install = yourls_create_sql_tables();
            if ( !empty( $install['error'] ) ) {
                $errors = array_merge( $errors, array_map( 'leanks_setup_friendly_install_error', $install['error'] ) );
            } else {
                yourls_create_htaccess();
                // Activating the plugin include()s plugin.php, which defines leanks_maybe_create_table();
                // call it right after so the metadata table exists even though 'plugins_loaded' already fired.
                $activation = yourls_activate_plugin( 'leanks/plugin.php' );
                if ( $activation !== true && $activation !== 'Plugin already activated' ) {
                    $errors[] = 'Tables were created, but the Leanks plugin could not activate automatically: ' . $activation . '. Activate it manually from /admin/plugins.php.';
                } elseif ( function_exists( 'leanks_maybe_create_table' ) ) {
                    leanks_maybe_create_table();
                }
                $success = empty( $errors );
            }
        } catch ( \Throwable $e ) {
            $errors[] = leanks_setup_friendly_db_error( $e );
        }
    }

    // $already_installed was false when this request started (otherwise the block above never
    // would have run), so if user/config.php exists now, this request wrote it. Remove it again
    // on any failure -- otherwise the wizard would block a retry with "already configured" even
    // though the install never actually finished.
    if ( !$success && file_exists( $config_path ) ) {
        @unlink( $config_path );
        $errors[] = "This attempt didn't finish, so the partially-written user/config.php was removed automatically -- fix the issue above, then submit the form again.";
    }
}
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set up Leanks</title>
<link rel="stylesheet" href="../app/css/app.css">
<style>
  body { padding: 40px 16px; }
  .setup-wrap { max-width: 520px; margin: 0 auto; }
  .setup-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 28px; }
  .setup-logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 1.2rem; margin-bottom: 6px; }
  .setup-sub { color: var(--text-dim); font-size: 0.88rem; margin-bottom: 24px; }
  .checklist { list-style: none; padding: 0; margin: 0 0 24px; font-size: 0.85rem; }
  .checklist li { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .checklist .ok { color: var(--green); } .checklist .no { color: var(--red); }
  .error-box { background: var(--red-bg); color: var(--red); padding: 10px 14px; border-radius: 8px; font-size: 0.85rem; margin-bottom: 16px; }
  .error-box ul { margin: 4px 0 0; padding-left: 18px; }
  .success-box { text-align: center; padding: 20px 0; }
  .success-box .icon { font-size: 2.5rem; margin-bottom: 10px; }
  .warn-box { background: var(--amber-bg); color: var(--amber); padding: 10px 14px; border-radius: 8px; font-size: 0.82rem; margin-top: 20px; }
  .setup-submit { width: 100%; margin-top: 8px; }
</style>
</head>
<body>
<div class="setup-wrap">
  <div class="setup-card">
    <div class="setup-logo"><span class="logo-mark">L</span> Leanks setup</div>

    <?php if ( $already_installed && !$success ) : ?>
      <p class="setup-sub">Leanks is already configured on this install.</p>
      <a class="btn btn-primary" href="../app/">Go to dashboard</a>
      <div class="warn-box">If you need to reconfigure, delete <code>user/config.php</code> first -- this wizard won't overwrite an existing install.</div>

    <?php elseif ( $success ) : ?>
      <div class="success-box">
        <div class="icon">✅</div>
        <h2 style="margin:0 0 6px;">You're all set</h2>
        <p class="setup-sub">YOURLS + Leanks are installed and the plugin is active.</p>
        <a class="btn btn-primary" href="../app/">Go to your dashboard →</a>
      </div>
      <div class="warn-box"><strong>Delete or password-protect the <code>/setup</code> folder now</strong> -- anyone who can reach it could reconfigure your database credentials.</div>

    <?php else : ?>
      <p class="setup-sub">Enter your database and admin details. This writes <code>user/config.php</code> and creates the tables.</p>

      <ul class="checklist">
        <?php foreach ( $checks as $label => $ok ) : ?>
          <li><span class="<?php echo $ok ? 'ok' : 'no'; ?>"><?php echo $ok ? '✓' : '✗'; ?></span> <?php echo htmlspecialchars( $label ); ?></li>
        <?php endforeach; ?>
      </ul>

      <?php if ( !empty( $errors ) ) : ?>
        <div class="error-box"><strong>Could not complete setup:</strong><ul><?php foreach ( $errors as $e ) echo '<li>' . htmlspecialchars( $e ) . '</li>'; ?></ul></div>
      <?php endif; ?>

      <form method="post">
        <div class="section-label">Database</div>
        <div class="input-row">
          <div class="field"><label>Host</label><input type="text" name="db_host" value="<?php echo htmlspecialchars( $values['db_host'] ); ?>" required></div>
          <div class="field"><label>Table prefix</label><input type="text" name="db_prefix" value="<?php echo htmlspecialchars( $values['db_prefix'] ); ?>" required></div>
        </div>
        <div class="field"><label>Database name</label><input type="text" name="db_name" value="<?php echo htmlspecialchars( $values['db_name'] ); ?>" required></div>
        <div class="input-row">
          <div class="field"><label>Database user</label><input type="text" name="db_user" value="<?php echo htmlspecialchars( $values['db_user'] ); ?>" required></div>
          <div class="field"><label>Database password</label><input type="password" name="db_pass" value="<?php echo htmlspecialchars( $values['db_pass'] ); ?>"></div>
        </div>

        <div class="section-label">Site</div>
        <div class="field"><label>Leanks URL</label><input type="url" name="site_url" value="<?php echo htmlspecialchars( $values['site_url'] ); ?>" required></div>

        <div class="section-label">Admin account</div>
        <div class="input-row">
          <div class="field"><label>Username</label><input type="text" name="admin_user" value="<?php echo htmlspecialchars( $values['admin_user'] ); ?>" required></div>
          <div class="field"><label>Password</label><input type="password" name="admin_pass" value="" required></div>
        </div>

        <input type="hidden" name="cookie_key" value="<?php echo htmlspecialchars( $values['cookie_key'] ); ?>">

        <button type="submit" class="btn btn-primary setup-submit">Install Leanks</button>
      </form>
    <?php endif; ?>
  </div>
</div>
</body>
</html>

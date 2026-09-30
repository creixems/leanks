<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Intercepts a short URL redirect to enforce expiration / click-limit / password protection.
 * Hooked on the 'redirect_shorturl' action, which fires with ($url, $keyword) right before
 * YOURLS logs the click and sends the redirect. Returning normally lets the click through;
 * calling exit() here stops it (and skips the click count/log for that request).
 *
 * Actions in YOURLS bundle all their extra arguments into a single array passed as one
 * parameter (see e.g. the bundled sample-toolbar plugin's ozh_toolbar_add()) -- unlike
 * WordPress, extra args are NOT unpacked into separate function parameters.
 *
 * @param array $args [ $url, $keyword ]
 */
function leanks_redirect_gate( $args ) {
    [ $url, $keyword ] = $args;
    $meta = leanks_get_meta( $keyword );
    if ( !$meta ) {
        return;
    }

    if ( !empty( $meta->expires_at ) && strtotime( $meta->expires_at ) <= time() ) {
        leanks_render_gate_page( yourls__( 'This link has expired.' ) );
        exit();
    }

    if ( !empty( $meta->max_clicks ) ) {
        $clicks = (int) yourls_get_keyword_clicks( $keyword );
        if ( $clicks >= (int) $meta->max_clicks ) {
            leanks_render_gate_page( yourls__( 'This link has reached its maximum number of clicks.' ) );
            exit();
        }
    }

    if ( !empty( $meta->password_hash ) ) {
        if ( leanks_has_password_cookie( $keyword ) ) {
            return;
        }

        $submitted = isset( $_POST['leanks_password'] ) ? (string) $_POST['leanks_password'] : null;
        if ( $submitted !== null ) {
            if ( password_verify( $submitted, $meta->password_hash ) ) {
                leanks_set_password_cookie( $keyword );
                return; // let the normal redirect proceed
            }
            leanks_render_password_form( $keyword, true );
            exit();
        }

        leanks_render_password_form( $keyword, false );
        exit();
    }
}
yourls_add_action( 'redirect_shorturl', 'leanks_redirect_gate' );

/**
 * Cookie proving the visitor already unlocked this password-protected link. HMAC-signed with
 * the install's own cookie key so no extra secret needs to be stored.
 */
function leanks_password_cookie_name( $keyword ) {
    return 'leanks_pw_' . substr( md5( $keyword ), 0, 12 );
}

function leanks_password_cookie_value( $keyword ) {
    return hash_hmac( 'sha256', 'leanks-password-ok:' . $keyword, yourls_get_cookie_key() );
}

function leanks_has_password_cookie( $keyword ) {
    $name = leanks_password_cookie_name( $keyword );
    return isset( $_COOKIE[ $name ] ) && hash_equals( leanks_password_cookie_value( $keyword ), $_COOKIE[ $name ] );
}

function leanks_set_password_cookie( $keyword ) {
    $name = leanks_password_cookie_name( $keyword );
    setcookie( $name, leanks_password_cookie_value( $keyword ), [
        'expires'  => time() + 12 * HOUR_IN_SECONDS,
        'path'     => '/',
        'secure'   => ( !empty( $_SERVER['HTTPS'] ) && $_SERVER['HTTPS'] !== 'off' ),
        'httponly' => true,
        'samesite' => 'Lax',
    ] );
}

if ( !defined( 'HOUR_IN_SECONDS' ) ) {
    define( 'HOUR_IN_SECONDS', 3600 );
}

function leanks_render_password_form( $keyword, $wrong_password ) {
    $error = $wrong_password ? '<p class="leanks-gate-error">' . yourls_esc_html__( 'Wrong password. Try again.' ) . '</p>' : '';
    $title = yourls_esc_html__( 'Password required' );
    $label = yourls_esc_html__( 'This link is password protected.' );
    $placeholder = yourls_esc_attr__( 'Password' );
    $button = yourls_esc_html__( 'Continue' );

    yourls_content_type_header( 'text/html' );
    echo leanks_gate_html( <<<HTML
        <h1>$title</h1>
        <p>$label</p>
        $error
        <form method="post">
            <input type="password" name="leanks_password" placeholder="$placeholder" autofocus required />
            <button type="submit">$button</button>
        </form>
HTML
    );
}

function leanks_render_gate_page( $message ) {
    yourls_content_type_header( 'text/html' );
    $safe = htmlspecialchars( $message, ENT_QUOTES );
    yourls_status_header( 410 );
    echo leanks_gate_html( "<h1>$safe</h1>" );
}

/**
 * Minimal, dependency-free HTML shell for the password/expired pages (no admin assets needed).
 */
function leanks_gate_html( $body ) {
    return <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Leanks</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #fafafa; color: #18181b; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; padding: 24px; box-sizing: border-box; }
  @media (prefers-color-scheme: dark) { body { background: #0a0a0a; color: #fafafa; } }
  .leanks-gate-card { max-width: 360px; width: 100%; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 8px; }
  p { color: #71717a; font-size: 0.9rem; margin: 0 0 20px; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input { padding: 10px 12px; border-radius: 8px; border: 1px solid #e4e4e7; font-size: 0.95rem; }
  button { padding: 10px 12px; border-radius: 8px; border: none; background: #18181b; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
  button:hover { background: #27272a; }
  .leanks-gate-error { color: #dc2626; }
</style>
</head>
<body>
  <div class="leanks-gate-card">$body</div>
</body>
</html>
HTML;
}

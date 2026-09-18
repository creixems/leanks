<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Site-wide Leanks settings. No new table -- stored as plain YOURLS options (same mechanism
 * everything else site-wide already uses, e.g. the update engine's leanks_installed_version).
 */

const LEANKS_DEFAULT_REDIRECT_OPTION = 'leanks_default_redirect';

function leanks_get_default_redirect() {
    return (string) yourls_get_option( LEANKS_DEFAULT_REDIRECT_OPTION, '' );
}

/**
 * A truly bare request to the site root -- yourls_get_request() returns '' -- never actually
 * reaches yourls-loader.php's redirect_keyword_not_found action on stock YOURLS: its own keyword
 * regex turns that '' into $keyword = null, and yourls_is_page(string $keyword) a few lines later
 * throws a TypeError on that null. This is a real, pre-existing bug in vendored core (confirmed
 * by testing, not a guess), not specific to any one PHP version -- a plain visit to the bare site
 * root fatals today regardless of this plugin.
 *
 * Hooking the earlier `pre_load_template` action instead -- fired right after $request is known,
 * before that regex ever runs -- sidesteps the crash entirely. When no redirect is configured,
 * this falls back to what core's own fallback further down would have done anyway (redirect back
 * to the site), so a bare-root visit is fixed either way, not just when a redirect URL is set.
 *
 * Actions in YOURLS bundle all their extra arguments into a single array passed as one parameter
 * -- unlike WordPress, extra args are NOT unpacked into separate function parameters (same quirk
 * documented in ajax.php's leanks_on_new_link()) -- true even for a single extra arg like this one.
 *
 * @param array $args [ $request ]
 */
function leanks_maybe_redirect_bare_root( $args ) {
    $request = $args[0] ?? null;
    if ( $request !== '' ) {
        return;
    }
    $url = leanks_get_default_redirect();
    yourls_redirect( $url !== '' ? $url : YOURLS_SITE, 302 );
    exit;
}
yourls_add_action( 'pre_load_template', 'leanks_maybe_redirect_bare_root' );

function leanks_ajax_get_settings() {
    leanks_json( [
        'success'          => true,
        'default_redirect' => leanks_get_default_redirect(),
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_get_settings', 'leanks_ajax_get_settings' );

function leanks_ajax_save_settings() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    $url = trim( (string) ( $_POST['default_redirect'] ?? '' ) );
    if ( $url !== '' && !preg_match( '#^https?://#i', $url ) ) {
        leanks_json( [ 'success' => false, 'message' => 'Redirect URL must start with http:// or https://, or be left blank to disable' ] );
    }

    yourls_update_option( LEANKS_DEFAULT_REDIRECT_OPTION, $url );
    leanks_json( [ 'success' => true ] );
}
yourls_add_action( 'yourls_ajax_leanks_save_settings', 'leanks_ajax_save_settings' );

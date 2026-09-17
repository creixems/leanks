<?php
/*
Plugin Name: Leanks
Plugin URI: https://github.com/jaimecreixems/leanks
Description: Powers the Leanks dashboard (/app): password-protected links, link expiration & click limits, and UTM metadata on top of stock YOURLS. Required for the custom Leanks admin UI to work.
Version: 1.0.0
Author: Leanks
Author URI: https://github.com/jaimecreixems/leanks
*/

// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

require_once __DIR__ . '/includes/meta.php';
require_once __DIR__ . '/includes/redirect-gate.php';
require_once __DIR__ . '/includes/ajax.php';
require_once __DIR__ . '/includes/import.php';

// Point back to the Leanks dashboard from the stock YOURLS admin menu, for discoverability.
yourls_add_action( 'admin_menu', 'leanks_add_admin_menu_link' );
function leanks_add_admin_menu_link() {
    echo '<li><a href="../app/">Leanks dashboard</a></li>';
}

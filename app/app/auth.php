<?php
/**
 * Thin auth bridge between the custom Leanks UI (static HTML/JS) and YOURLS' own session/cookie
 * auth. Deliberately bypasses yourls_maybe_require_auth() / yourls_is_valid_user(), which are
 * built to render YOURLS' own HTML login page and redirect -- not to be called from fetch().
 * Everything here is a small, non-dying JSON wrapper around the underlying primitives.
 */

define( 'YOURLS_ADMIN', true );
require_once dirname( __DIR__ ) . '/includes/load-yourls.php';

header( 'Content-Type: application/json' );

// GET ?check=1 - am I currently logged in? Safe to call anonymously: with no username/password
// in the request, yourls_is_valid_user() only checks the existing cookie, no side effects.
if ( isset( $_GET['check'] ) ) {
    echo json_encode( [ 'authenticated' => yourls_is_valid_user() === true ] );
    exit();
}

// GET - hand out a fresh login nonce for the form to submit back.
if ( $_SERVER['REQUEST_METHOD'] === 'GET' ) {
    echo json_encode( [ 'nonce' => yourls_create_nonce( 'admin_login' ) ] );
    exit();
}

// POST ?logout=1
if ( isset( $_POST['logout'] ) ) {
    yourls_store_cookie( '' );
    echo json_encode( [ 'success' => true ] );
    exit();
}

// POST - attempt login with username/password/nonce.
global $yourls_user_passwords;

$username = (string) ( $_POST['username'] ?? '' );
$password = (string) ( $_POST['password'] ?? '' );
$nonce    = (string) ( $_POST['nonce'] ?? '' );

$valid_nonce = hash_equals( yourls_create_nonce( 'admin_login' ), $nonce );

if ( $valid_nonce && isset( $yourls_user_passwords[ $username ] ) && yourls_check_password_hash( $username, $password ) ) {
    yourls_set_user( $username );
    yourls_store_cookie( YOURLS_USER );
    echo json_encode( [ 'success' => true ] );
} else {
    http_response_code( 401 );
    echo json_encode( [ 'success' => false, 'message' => 'Invalid username or password' ] );
}

<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Leanks' own tiny schema-migration runner, separate from YOURLS' core upgrade machinery
 * (which is a bespoke, hardcoded cascade tied to YOURLS' own historical versions -- not
 * something a plugin can hook into). Tracks a single integer version via the same
 * yourls_get_option()/yourls_update_option() mechanism YOURLS itself uses for 'db_version'.
 *
 * Empty today -- leanks_maybe_create_table() (includes/meta.php) already creates the current
 * schema from scratch on a fresh install. This exists purely as wiring so a future release that
 * needs to ALTER `leanks_meta` (e.g. add a column) has somewhere to put that migration, run
 * automatically as part of the update engine's leanks_ajax_run_update() flow.
 */

define( 'LEANKS_DB_VERSION', 1 );

/**
 * Ordered list of pending migrations: db version reached -> callable that performs it.
 * Add new entries here as the schema evolves; never renumber or remove old ones.
 */
function leanks_migrations() {
    return [
        // 2 => 'leanks_migrate_to_2',
    ];
}

function leanks_run_migrations() {
    $current = (int) yourls_get_option( 'leanks_db_version', 1 );

    foreach ( leanks_migrations() as $version => $callback ) {
        if ( $version > $current && function_exists( $callback ) ) {
            call_user_func( $callback );
            $current = $version;
            yourls_update_option( 'leanks_db_version', $current );
        }
    }

    if ( $current !== LEANKS_DB_VERSION && $current < LEANKS_DB_VERSION ) {
        yourls_update_option( 'leanks_db_version', LEANKS_DB_VERSION );
    }
}

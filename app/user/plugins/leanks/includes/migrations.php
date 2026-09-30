<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Leanks' own tiny schema-migration runner, separate from YOURLS' core upgrade machinery
 * (which is a bespoke, hardcoded cascade tied to YOURLS' own historical versions -- not
 * something a plugin can hook into). Tracks a single integer version via the same
 * yourls_get_option()/yourls_update_option() mechanism YOURLS itself uses for 'db_version'.
 *
 * leanks_maybe_create_table() (includes/meta.php) creates the current `leanks_meta` schema from
 * scratch on a fresh install, so this runner is only needed for ALTERs against already-existing
 * installs. It's run both by the update engine's leanks_ajax_run_update() flow and, so a plain
 * `git pull`/manual-upload deploy picks up new migrations too, on every normal page load via the
 * plugins_loaded hook at the bottom of this file.
 */

define( 'LEANKS_DB_VERSION', 2 );

/**
 * Ordered list of pending migrations: db version reached -> callable that performs it.
 * Add new entries here as the schema evolves; never renumber or remove old ones.
 */
function leanks_migrations() {
    return [
        2 => 'leanks_migrate_add_analytics_indexes',
    ];
}

/**
 * Adds the indexes the Analytics page's date-range/grouped queries need on the click log table.
 * MySQL has no `ADD INDEX IF NOT EXISTS` before 8.0.29, so each index is checked via SHOW INDEX
 * first -- same defensive style as the SHOW COLUMNS-based checks in includes/functions-upgrade.php.
 */
function leanks_migrate_add_analytics_indexes() {
    $table = YOURLS_DB_TABLE_LOG;
    $db = yourls_get_db( 'write-leanks_migrate_2' );

    $wanted = [
        'leanks_click_time'          => "ALTER TABLE `$table` ADD INDEX `leanks_click_time` (`click_time`)",
        'leanks_country_code'        => "ALTER TABLE `$table` ADD INDEX `leanks_country_code` (`country_code`)",
        'leanks_shorturl_click_time' => "ALTER TABLE `$table` ADD INDEX `leanks_shorturl_click_time` (`shorturl`, `click_time`)",
    ];

    foreach ( $wanted as $index_name => $sql ) {
        $exists = $db->fetchObjects( "SHOW INDEX FROM `$table` WHERE Key_name = '$index_name'" );
        if ( empty( $exists ) ) {
            $db->perform( $sql );
        }
    }
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
// Run on every normal load (not just through the self-updater) so manual/git-pull deploys are
// covered too. Priority 20: after leanks_maybe_create_table()'s default-priority (10) run in
// meta.php, so a migration can safely assume `leanks_meta` already exists.
yourls_add_action( 'plugins_loaded', 'leanks_run_migrations', 20 );

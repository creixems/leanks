<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Name of the extra metadata table (password/expiration/UTM per link).
 */
function leanks_meta_table() {
    return YOURLS_DB_PREFIX . 'leanks_meta';
}

/**
 * Create the metadata table if it doesn't exist yet. Idempotent, safe to call on every load.
 */
function leanks_maybe_create_table() {
    $table = leanks_meta_table();

    yourls_get_db( 'write-leanks_create_table' )->perform(
        "CREATE TABLE IF NOT EXISTS `$table` (
            `keyword` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT '',
            `password_hash` varchar(255) DEFAULT NULL,
            `expires_at` datetime DEFAULT NULL,
            `max_clicks` int(10) unsigned DEFAULT NULL,
            `utm_source` varchar(191) DEFAULT NULL,
            `utm_medium` varchar(191) DEFAULT NULL,
            `utm_campaign` varchar(191) DEFAULT NULL,
            `utm_term` varchar(191) DEFAULT NULL,
            `utm_content` varchar(191) DEFAULT NULL,
            `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
            PRIMARY KEY (`keyword`)
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;"
    );
}
yourls_add_action( 'plugins_loaded', 'leanks_maybe_create_table' );

/**
 * Fetch the metadata row for a keyword, or null if none / all-empty.
 *
 * @param string $keyword
 * @return object|null
 */
function leanks_get_meta( $keyword ) {
    $table = leanks_meta_table();
    $row = yourls_get_db( 'read-leanks_get_meta' )->fetchObject(
        "SELECT * FROM `$table` WHERE `keyword` = :keyword",
        [ 'keyword' => $keyword ]
    );
    return $row ?: null;
}

/**
 * Create or update the metadata row for a keyword.
 *
 * Recognized keys in $fields: password_hash (string|null), expires_at (string|null, 'Y-m-d H:i:s'),
 * max_clicks (int|null), utm_source/utm_medium/utm_campaign/utm_term/utm_content (string|null).
 * Only keys actually present in $fields are written; others are left untouched.
 *
 * @param string $keyword
 * @param array  $fields
 * @return bool
 */
function leanks_save_meta( $keyword, array $fields ) {
    $table = leanks_meta_table();
    $allowed = [ 'password_hash', 'expires_at', 'max_clicks', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content' ];
    $fields = array_intersect_key( $fields, array_flip( $allowed ) );

    if ( empty( $fields ) ) {
        return true;
    }

    $exists = leanks_get_meta( $keyword );
    $db = yourls_get_db( 'write-leanks_save_meta' );

    if ( $exists ) {
        $sets = [];
        $binds = [ 'keyword' => $keyword ];
        foreach ( $fields as $col => $val ) {
            $sets[] = "`$col` = :$col";
            $binds[ $col ] = $val;
        }
        $sql = "UPDATE `$table` SET " . implode( ', ', $sets ) . " WHERE `keyword` = :keyword";
        $db->perform( $sql, $binds );
        return true;
    }

    $fields['keyword'] = $keyword;
    $cols = array_map( fn( $c ) => "`$c`", array_keys( $fields ) );
    $placeholders = array_map( fn( $c ) => ":$c", array_keys( $fields ) );
    $sql = "INSERT INTO `$table` (" . implode( ',', $cols ) . ") VALUES (" . implode( ',', $placeholders ) . ")";
    $db->perform( $sql, $fields );
    return true;
}

/**
 * Delete the metadata row for a keyword (called when a link itself is deleted).
 *
 * Actions in YOURLS bundle all their extra arguments into a single array passed as one
 * parameter -- unlike WordPress, extra args are NOT unpacked into separate function parameters.
 *
 * @param array $args [ $keyword, $affected_rows ]
 */
function leanks_delete_meta( $args ) {
    $keyword = $args[0];
    $table = leanks_meta_table();
    yourls_get_db( 'write-leanks_delete_meta' )->perform(
        "DELETE FROM `$table` WHERE `keyword` = :keyword",
        [ 'keyword' => $keyword ]
    );
}
yourls_add_action( 'delete_link', 'leanks_delete_meta' );

/**
 * Keep metadata attached to the right row when a link's keyword (its primary key) is renamed
 * via the edit form.
 */
function leanks_on_edit_link( $return, $url, $keyword, $newkeyword, $title ) {
    if ( !empty( $return['status'] ) && $return['status'] === 'success' && $keyword !== $newkeyword ) {
        $table = leanks_meta_table();
        yourls_get_db( 'write-leanks_rename_meta' )->perform(
            "UPDATE `$table` SET `keyword` = :new WHERE `keyword` = :old",
            [ 'new' => $newkeyword, 'old' => $keyword ]
        );
    }
    return $return;
}
yourls_add_filter( 'edit_link', 'leanks_on_edit_link', 10, 5 );

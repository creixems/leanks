<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Tags: a small many-to-many system on top of stock YOURLS links. Two tables, created the same
 * way `leanks_meta` is (includes/meta.php) -- CREATE TABLE IF NOT EXISTS on plugins_loaded, no
 * migration needed since these are brand new tables, not an ALTER to an existing one.
 */

/**
 * Fixed color palette a tag's `color` column is constrained to -- matches the badge tokens in
 * app/css/app.css (badge-red/yellow/green/blue/purple/brown/gray, Tailwind-sourced hex values),
 * so tag chips render with the same design-system colors as every other badge in the app rather
 * than arbitrary hex values.
 */
function leanks_tag_colors() {
    return [ 'red', 'yellow', 'green', 'blue', 'purple', 'brown', 'gray' ];
}

function leanks_tags_table() {
    return YOURLS_DB_PREFIX . 'leanks_tags';
}

function leanks_link_tags_table() {
    return YOURLS_DB_PREFIX . 'leanks_link_tags';
}

function leanks_maybe_create_tags_tables() {
    $db = yourls_get_db( 'write-leanks_create_tags_tables' );
    $tags = leanks_tags_table();
    $link_tags = leanks_link_tags_table();

    $db->perform(
        "CREATE TABLE IF NOT EXISTS `$tags` (
            `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
            `name` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            `color` varchar(20) NOT NULL DEFAULT 'gray',
            `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
            PRIMARY KEY (`id`),
            UNIQUE KEY `name` (`name`)
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;"
    );

    $db->perform(
        "CREATE TABLE IF NOT EXISTS `$link_tags` (
            `keyword` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
            `tag_id` int(10) unsigned NOT NULL,
            PRIMARY KEY (`keyword`, `tag_id`),
            KEY `tag_id` (`tag_id`)
        ) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;"
    );
}
yourls_add_action( 'plugins_loaded', 'leanks_maybe_create_tags_tables' );

/**
 * All tags, each with how many links currently carry it.
 *
 * @return array<int, array{id:int,name:string,color:string,link_count:int}>
 */
function leanks_list_tags() {
    $tags = leanks_tags_table();
    $link_tags = leanks_link_tags_table();

    $rows = yourls_get_db( 'read-leanks_list_tags' )->fetchObjects(
        "SELECT t.id, t.name, t.color, COUNT(lt.keyword) AS link_count
         FROM `$tags` t
         LEFT JOIN `$link_tags` lt ON lt.tag_id = t.id
         GROUP BY t.id, t.name, t.color
         ORDER BY t.name ASC"
    );

    return array_map( fn( $r ) => [
        'id'         => (int) $r->id,
        'name'       => $r->name,
        'color'      => $r->color,
        'link_count' => (int) $r->link_count,
    ], $rows );
}

/**
 * @return int|null the new tag's id, or null if the name is empty/already taken
 */
function leanks_create_tag( $name, $color ) {
    $name = trim( (string) $name );
    $color = in_array( $color, leanks_tag_colors(), true ) ? $color : 'gray';
    if ( $name === '' ) {
        return null;
    }

    $db = yourls_get_db( 'write-leanks_create_tag' );
    $tags = leanks_tags_table();

    $exists = $db->fetchValue( "SELECT id FROM `$tags` WHERE name = :name", [ 'name' => $name ] );
    if ( $exists ) {
        return null;
    }

    $db->perform( "INSERT INTO `$tags` (name, color) VALUES (:name, :color)", [ 'name' => $name, 'color' => $color ] );
    return (int) $db->lastInsertId();
}

/**
 * @param int   $id
 * @param array $fields recognized keys: name, color
 * @return bool false if the tag doesn't exist or the new name collides with another tag
 */
function leanks_update_tag( $id, array $fields ) {
    $db = yourls_get_db( 'write-leanks_update_tag' );
    $tags = leanks_tags_table();

    $sets = [];
    $binds = [ 'id' => (int) $id ];

    if ( array_key_exists( 'name', $fields ) ) {
        $name = trim( (string) $fields['name'] );
        if ( $name === '' ) {
            return false;
        }
        $taken = $db->fetchValue( "SELECT id FROM `$tags` WHERE name = :name AND id != :id", [ 'name' => $name, 'id' => (int) $id ] );
        if ( $taken ) {
            return false;
        }
        $sets[] = 'name = :name';
        $binds['name'] = $name;
    }
    if ( array_key_exists( 'color', $fields ) ) {
        $sets[] = 'color = :color';
        $binds['color'] = in_array( $fields['color'], leanks_tag_colors(), true ) ? $fields['color'] : 'gray';
    }

    if ( empty( $sets ) ) {
        return true;
    }

    $db->perform( "UPDATE `$tags` SET " . implode( ', ', $sets ) . " WHERE id = :id", $binds );
    return true;
}

function leanks_delete_tag( $id ) {
    $id = (int) $id;
    $db = yourls_get_db( 'write-leanks_delete_tag' );
    $db->perform( "DELETE FROM `" . leanks_link_tags_table() . "` WHERE tag_id = :id", [ 'id' => $id ] );
    $db->perform( "DELETE FROM `" . leanks_tags_table() . "` WHERE id = :id", [ 'id' => $id ] );
}

/**
 * Replaces the full set of tags on a link (delete + reinsert) -- simplest given how few tags a
 * single link realistically carries.
 *
 * @param string $keyword
 * @param int[]  $tag_ids
 */
function leanks_set_link_tags( $keyword, array $tag_ids ) {
    $db = yourls_get_db( 'write-leanks_set_link_tags' );
    $link_tags = leanks_link_tags_table();

    $db->perform( "DELETE FROM `$link_tags` WHERE keyword = :keyword", [ 'keyword' => $keyword ] );

    $tag_ids = array_values( array_unique( array_map( 'intval', $tag_ids ) ) );
    foreach ( $tag_ids as $tag_id ) {
        if ( $tag_id <= 0 ) {
            continue;
        }
        $db->perform(
            "INSERT IGNORE INTO `$link_tags` (keyword, tag_id) VALUES (:keyword, :tag_id)",
            [ 'keyword' => $keyword, 'tag_id' => $tag_id ]
        );
    }
}

/**
 * Batched tag lookup for a set of keywords -- one query for the whole links list instead of one
 * per row.
 *
 * @param string[] $keywords
 * @return array<string, array<int, array{id:int,name:string,color:string}>>
 */
function leanks_get_tags_for_keywords( array $keywords ) {
    $keywords = array_values( array_unique( array_filter( $keywords, fn( $k ) => $k !== '' ) ) );
    if ( empty( $keywords ) ) {
        return [];
    }

    $tags = leanks_tags_table();
    $link_tags = leanks_link_tags_table();

    $placeholders = [];
    $binds = [];
    foreach ( $keywords as $i => $kw ) {
        $placeholders[] = ":kw_$i";
        $binds[ "kw_$i" ] = $kw;
    }

    $rows = yourls_get_db( 'read-leanks_get_tags_for_keywords' )->fetchObjects(
        "SELECT lt.keyword, t.id, t.name, t.color
         FROM `$link_tags` lt
         JOIN `$tags` t ON t.id = lt.tag_id
         WHERE lt.keyword IN (" . implode( ',', $placeholders ) . ")
         ORDER BY t.name ASC",
        $binds
    );

    $byKeyword = [];
    foreach ( $rows as $r ) {
        $byKeyword[ $r->keyword ][] = [ 'id' => (int) $r->id, 'name' => $r->name, 'color' => $r->color ];
    }
    return $byKeyword;
}

/**
 * Finds a tag by (case-sensitive) name, creating it with a default color if it doesn't exist yet.
 * Used by the CSV importer when a row carries tag names that may not exist as tags already.
 *
 * @return int the tag's id
 */
function leanks_find_or_create_tag_by_name( $name ) {
    $name = trim( (string) $name );
    $tags = leanks_tags_table();
    $db = yourls_get_db( 'write-leanks_find_or_create_tag' );

    $id = $db->fetchValue( "SELECT id FROM `$tags` WHERE name = :name", [ 'name' => $name ] );
    if ( $id ) {
        return (int) $id;
    }

    $db->perform( "INSERT INTO `$tags` (name, color) VALUES (:name, 'gray')", [ 'name' => $name ] );
    return (int) $db->lastInsertId();
}

/**
 * Keep link_tags in sync with the link itself: drop rows when the link is deleted, re-key them
 * when its keyword (primary key) is renamed. Same two hooks includes/meta.php already uses.
 */
function leanks_delete_link_tags( $args ) {
    $keyword = $args[0];
    yourls_get_db( 'write-leanks_delete_link_tags' )->perform(
        "DELETE FROM `" . leanks_link_tags_table() . "` WHERE keyword = :keyword",
        [ 'keyword' => $keyword ]
    );
}
yourls_add_action( 'delete_link', 'leanks_delete_link_tags' );

function leanks_on_edit_link_rename_tags( $return, $url, $keyword, $newkeyword, $title ) {
    if ( !empty( $return['status'] ) && $return['status'] === 'success' && $keyword !== $newkeyword ) {
        yourls_get_db( 'write-leanks_rename_link_tags' )->perform(
            "UPDATE `" . leanks_link_tags_table() . "` SET keyword = :new WHERE keyword = :old",
            [ 'new' => $newkeyword, 'old' => $keyword ]
        );
    }
    return $return;
}
yourls_add_filter( 'edit_link', 'leanks_on_edit_link_rename_tags', 10, 5 );

/* ----------------------------------------------------------------------------------------------
 * Ajax endpoints
 * ------------------------------------------------------------------------------------------- */

function leanks_ajax_tags_list() {
    leanks_json( [ 'success' => true, 'tags' => leanks_list_tags(), 'colors' => leanks_tag_colors() ] );
}
yourls_add_action( 'yourls_ajax_leanks_tags_list', 'leanks_ajax_tags_list' );

function leanks_ajax_tags_create() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    $id = leanks_create_tag( $_POST['name'] ?? '', $_POST['color'] ?? 'gray' );
    if ( $id === null ) {
        leanks_json( [ 'success' => false, 'message' => 'Tag name is required and must be unique' ] );
    }
    leanks_json( [ 'success' => true, 'id' => $id ] );
}
yourls_add_action( 'yourls_ajax_leanks_tags_create', 'leanks_ajax_tags_create' );

function leanks_ajax_tags_update() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    $id = (int) ( $_POST['id'] ?? 0 );
    if ( $id <= 0 ) {
        leanks_json( [ 'success' => false, 'message' => 'Unknown tag' ] );
    }

    $fields = [];
    if ( isset( $_POST['name'] ) ) {
        $fields['name'] = $_POST['name'];
    }
    if ( isset( $_POST['color'] ) ) {
        $fields['color'] = $_POST['color'];
    }

    $ok = leanks_update_tag( $id, $fields );
    leanks_json( $ok ? [ 'success' => true ] : [ 'success' => false, 'message' => 'Tag name is required and must be unique' ] );
}
yourls_add_action( 'yourls_ajax_leanks_tags_update', 'leanks_ajax_tags_update' );

function leanks_ajax_tags_delete() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    $id = (int) ( $_POST['id'] ?? 0 );
    if ( $id <= 0 ) {
        leanks_json( [ 'success' => false, 'message' => 'Unknown tag' ] );
    }

    leanks_delete_tag( $id );
    leanks_json( [ 'success' => true ] );
}
yourls_add_action( 'yourls_ajax_leanks_tags_delete', 'leanks_ajax_tags_delete' );

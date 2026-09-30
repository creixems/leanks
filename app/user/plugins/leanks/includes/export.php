<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * CSV export -- the exact inverse of import.php. The header row uses dub.co's own column names
 * (Destination URL, Short link, Title, Creation date, Clicks, Tags), which import.php's alias map
 * recognizes, so a file exported here re-imports cleanly into another Leanks install.
 *
 * Only what the import format can carry is exported: passwords, expirations/click limits and UTM
 * fields live in leanks_meta and have no column in the import format, so they don't travel.
 */

const LEANKS_EXPORT_BATCH = 1000;

/**
 * Guard against CSV/formula injection when the file is opened in a spreadsheet: a title is
 * scraped from whatever page a link points at, so a value starting with = + - @ (or a control
 * character) could otherwise execute as a formula. A leading apostrophe makes Excel/Sheets/Numbers
 * treat the cell as text. Only free-text fields are guarded -- URLs and short links must
 * round-trip byte-for-byte.
 */
function leanks_export_safe_text( $value ) {
    $value = (string) $value;
    if ( $value !== '' && strpos( "=+-@\t\r", $value[0] ) !== false ) {
        return "'" . $value;
    }
    return $value;
}

/**
 * Tag names go into one comma-separated cell, so a comma/semicolon/backslash inside a name is
 * backslash-escaped; import.php's leanks_import_split_tags() reverses it.
 */
function leanks_export_escape_tag( $name ) {
    return preg_replace( '/([,;\\\\])/', '\\\\$1', (string) $name );
}

function leanks_ajax_export() {
    $table = YOURLS_DB_TABLE_URL;
    $db = yourls_get_db( 'read-leanks_export' );

    $filename = 'leanks-links-' . date( 'Y-m-d' ) . '.csv';
    // A download, not JSON -- send the headers admin-ajax.php's JSON actions never need.
    header( 'Content-Type: text/csv; charset=utf-8' );
    header( 'Content-Disposition: attachment; filename="' . $filename . '"' );
    header( 'Cache-Control: no-store' );

    $out = fopen( 'php://output', 'w' );
    // UTF-8 BOM so Excel opens non-ASCII titles correctly; PHP's own fgetcsv() import path
    // tolerates it because the column-name matcher strips everything but letters/digits.
    fwrite( $out, "\xEF\xBB\xBF" );
    fputcsv( $out, [ 'Destination URL', 'Short link', 'Title', 'Creation date', 'Clicks', 'Tags' ] );

    // Batched by keyword-ordered offset rather than one giant fetch, so a large install can't
    // exhaust PHP's memory limit. Ordered oldest-first (timestamp, then keyword as a tiebreaker
    // so pages are stable) -- re-importing then recreates links in their original order.
    $offset = 0;
    do {
        $rows = $db->fetchObjects(
            "SELECT keyword, url, title, timestamp, clicks FROM `$table`
             ORDER BY timestamp ASC, keyword ASC
             LIMIT " . LEANKS_EXPORT_BATCH . " OFFSET $offset"
        );
        $tags_by_keyword = leanks_get_tags_for_keywords( array_map( fn( $r ) => $r->keyword, $rows ) );

        foreach ( $rows as $r ) {
            $tag_names = array_map( fn( $t ) => leanks_export_escape_tag( $t['name'] ), $tags_by_keyword[ $r->keyword ] ?? [] );
            fputcsv( $out, [
                $r->url,
                yourls_link( $r->keyword ),
                leanks_export_safe_text( $r->title ),
                $r->timestamp,
                (int) $r->clicks,
                implode( ', ', $tag_names ),
            ] );
        }
        $offset += LEANKS_EXPORT_BATCH;
    } while ( count( $rows ) === LEANKS_EXPORT_BATCH );

    fclose( $out );
    die();
}
yourls_add_action( 'yourls_ajax_leanks_export', 'leanks_ajax_export' );

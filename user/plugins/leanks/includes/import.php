<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * CSV import, aimed at dub.co's own export/import template (Destination URL / Short link /
 * Title / Description / Tags / Creation date -- see https://dub.co/help/article/how-to-import-csv)
 * but tolerant of other column names/order, since dub.co itself says "the actual names of your
 * columns can be anything you want".
 */

const LEANKS_IMPORT_MAX_ROWS = 2000;

/**
 * Column aliases we recognize, normalized (lowercase, letters/digits only) -> field name.
 */
function leanks_import_column_aliases() {
    return [
        'url'                => 'url',
        'destinationurl'     => 'url',
        'longurl'            => 'url',
        'originalurl'        => 'url',
        'targeturl'          => 'url',
        'destination'        => 'url',

        'shortlink'          => 'short',
        'shorturl'           => 'short',
        'short'              => 'short',
        'key'                => 'short',
        'slug'               => 'short',
        'alias'              => 'short',

        'title'              => 'title',
        'name'               => 'title',
        'linktitle'          => 'title',

        'creationdate'       => 'created',
        'createddate'        => 'created',
        'createdat'          => 'created',
        'datecreated'        => 'created',
        'date'               => 'created',

        'clicks'             => 'clicks',
        'clickcount'         => 'clicks',
        'numberofclicks'     => 'clicks',

        'tags'               => 'tags',
        'tag'                => 'tags',
    ];
}

function leanks_import_normalize_header( $header ) {
    return preg_replace( '/[^a-z0-9]/', '', strtolower( trim( $header ) ) );
}

/**
 * Pull just the slug/keyword out of a "short link" cell, which may be a bare slug ("abc123"),
 * a host+path ("yourdomain.com/abc123"), or a full URL ("https://yourdomain.com/abc123").
 */
function leanks_import_extract_keyword( $value ) {
    $value = trim( (string) $value );
    if ( $value === '' ) {
        return '';
    }
    // A bare slug ("abc123") has no scheme and no slash at all -- it's already the keyword.
    // Without this check, prepending "https://" turns it into a bare hostname with no path
    // component (parse_url("https://abc123", PHP_URL_PATH) is empty), so the code below would
    // silently discard it and fall through to an auto-generated keyword instead.
    if ( strpos( $value, '/' ) === false && !preg_match( '#^[a-z][a-z0-9+.-]*://#i', $value ) ) {
        return $value;
    }
    if ( !preg_match( '#^[a-z][a-z0-9+.-]*://#i', $value ) ) {
        $value = 'https://' . $value;
    }
    $path = (string) parse_url( $value, PHP_URL_PATH );
    $path = trim( $path, '/' );
    if ( $path === '' ) {
        return '';
    }
    $parts = explode( '/', $path );
    return end( $parts );
}

function leanks_ajax_import() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    if ( empty( $_FILES['csv'] ) || $_FILES['csv']['error'] !== UPLOAD_ERR_OK ) {
        leanks_json( [ 'success' => false, 'message' => 'No CSV file was uploaded (or the upload failed).' ] );
    }

    $handle = fopen( $_FILES['csv']['tmp_name'], 'r' );
    if ( !$handle ) {
        leanks_json( [ 'success' => false, 'message' => 'Could not read the uploaded file.' ] );
    }

    $header = fgetcsv( $handle );
    if ( !$header ) {
        fclose( $handle );
        leanks_json( [ 'success' => false, 'message' => 'The CSV file looks empty.' ] );
    }

    $aliases = leanks_import_column_aliases();
    $columns = []; // field name => column index
    foreach ( $header as $i => $col ) {
        $norm = leanks_import_normalize_header( $col );
        if ( isset( $aliases[ $norm ] ) && !isset( $columns[ $aliases[ $norm ] ] ) ) {
            $columns[ $aliases[ $norm ] ] = $i;
        }
    }

    if ( !isset( $columns['url'] ) ) {
        fclose( $handle );
        leanks_json( [
            'success' => false,
            'message' => 'Could not find a destination URL column. Expected a column named "Destination URL", "URL", or similar -- found: ' . implode( ', ', $header ),
        ] );
    }

    @set_time_limit( 120 );

    $imported = 0;
    $skipped = 0;
    $errors = [];
    $row_count = 0;

    while ( ( $row = fgetcsv( $handle ) ) !== false ) {
        if ( count( $row ) === 1 && trim( (string) $row[0] ) === '' ) {
            continue; // blank line
        }
        $row_count++;
        if ( $row_count > LEANKS_IMPORT_MAX_ROWS ) {
            break;
        }

        $url = isset( $columns['url'] ) ? trim( (string) ( $row[ $columns['url'] ] ?? '' ) ) : '';
        $short = isset( $columns['short'] ) ? trim( (string) ( $row[ $columns['short'] ] ?? '' ) ) : '';
        $title = isset( $columns['title'] ) ? trim( (string) ( $row[ $columns['title'] ] ?? '' ) ) : '';
        $created = isset( $columns['created'] ) ? trim( (string) ( $row[ $columns['created'] ] ?? '' ) ) : '';
        $clicks = isset( $columns['clicks'] ) ? trim( (string) ( $row[ $columns['clicks'] ] ?? '' ) ) : '';
        $tags = isset( $columns['tags'] ) ? trim( (string) ( $row[ $columns['tags'] ] ?? '' ) ) : '';

        if ( $url === '' ) {
            $skipped++;
            $errors[] = [ 'row' => $row_count, 'url' => '', 'message' => 'Missing destination URL' ];
            continue;
        }

        $keyword = $short !== '' ? leanks_import_extract_keyword( $short ) : '';
        // Fall back to the URL itself as a title so yourls_add_new_link() doesn't try to fetch
        // the remote page's <title> for every row with no title -- slow and unreliable in bulk.
        $safe_title = $title !== '' ? $title : $url;

        $return = yourls_add_new_link( $url, $keyword, $safe_title );

        if ( empty( $return['status'] ) || $return['status'] !== 'success' ) {
            $skipped++;
            $errors[] = [
                'row'     => $row_count,
                'url'     => $url,
                'message' => $return['message'] ?? 'Unknown error',
            ];
            continue;
        }

        $imported++;

        if ( $created !== '' ) {
            $ts = strtotime( $created );
            if ( $ts !== false ) {
                yourls_get_db( 'write-leanks_import_backdate' )->perform(
                    'UPDATE `' . YOURLS_DB_TABLE_URL . '` SET `timestamp` = :ts WHERE `keyword` = :keyword',
                    [ 'ts' => date( 'Y-m-d H:i:s', $ts ), 'keyword' => $return['url']['keyword'] ]
                );
            }
        }

        // yourls_add_new_link() always inserts with clicks = 0 -- there's no way to set a
        // starting count at creation, so set it with the same function YOURLS itself uses to
        // update a link's click count. This is only ever a starting total: an import can't
        // backfill the Analytics page's per-day/referrer/country breakdowns, since a CSV export
        // has no per-click log, only totals.
        if ( $clicks !== '' && ctype_digit( $clicks ) && (int) $clicks > 0 ) {
            yourls_update_clicks( $return['url']['keyword'], (int) $clicks );
        }

        if ( $tags !== '' ) {
            $tag_ids = [];
            foreach ( preg_split( '/[,;]/', $tags ) as $tag_name ) {
                $tag_name = trim( $tag_name );
                if ( $tag_name !== '' ) {
                    $tag_ids[] = leanks_find_or_create_tag_by_name( $tag_name );
                }
            }
            if ( !empty( $tag_ids ) ) {
                leanks_set_link_tags( $return['url']['keyword'], $tag_ids );
            }
        }
    }
    fclose( $handle );

    leanks_json( [
        'success'   => true,
        'imported'  => $imported,
        'skipped'   => $skipped,
        'errors'    => array_slice( $errors, 0, 25 ),
        'truncated' => $row_count > LEANKS_IMPORT_MAX_ROWS,
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_import', 'leanks_ajax_import' );

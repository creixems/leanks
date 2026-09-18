<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Custom admin-ajax.php actions backing the Leanks dashboard (app/). All of these run behind
 * admin-ajax.php's own yourls_maybe_require_auth() check, so they're only reachable when logged in.
 * Reached via admin-ajax.php?action=leanks_xxx -> yourls_do_action('yourls_ajax_leanks_xxx').
 */

const LEANKS_NONCE_ACTION = 'leanks_save_meta';

function leanks_json( $data ) {
    echo json_encode( $data );
    die();
}

function leanks_verify_nonce_json( $nonce, $action = LEANKS_NONCE_ACTION ) {
    yourls_verify_nonce( $action, $nonce, false, json_encode( [ 'success' => false, 'message' => 'Invalid or expired nonce' ] ) );
}

/**
 * Bootstrap data for the app shell: nonces, site info, current user.
 */
function leanks_ajax_bootstrap() {
    leanks_json( [
        'nonce_add'       => yourls_create_nonce( 'add_url' ),
        'nonce_meta'      => yourls_create_nonce( LEANKS_NONCE_ACTION ),
        'nonce_import'    => yourls_create_nonce( LEANKS_NONCE_ACTION ),
        'nonce_update'    => yourls_create_nonce( 'leanks_run_update' ),
        'site_url'        => yourls_get_yourls_site(),
        'user'            => defined( 'YOURLS_USER' ) ? YOURLS_USER : '',
        'url_convert'     => yourls_get_url_convert(),
        'leanks_version'  => LEANKS_VERSION,
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_bootstrap', 'leanks_ajax_bootstrap' );

/**
 * Paginated, searchable, sortable, tag-filterable link list, links joined with their Leanks
 * metadata and tags.
 */
function leanks_ajax_list() {
    $table = YOURLS_DB_TABLE_URL;
    $meta_table = leanks_meta_table();
    $link_tags_table = leanks_link_tags_table();

    $search   = isset( $_GET['search'] ) ? trim( (string) $_GET['search'] ) : '';
    $tag_id   = (int) ( $_GET['tag_id'] ?? 0 );
    $page     = max( 1, (int) ( $_GET['page'] ?? 1 ) );
    $perpage  = min( 100, max( 1, (int) ( $_GET['perpage'] ?? 20 ) ) );
    $offset   = ( $page - 1 ) * $perpage;
    $sort     = in_array( $_GET['sort'] ?? '', [ 'timestamp', 'clicks', 'keyword' ], true ) ? $_GET['sort'] : 'timestamp';
    $order    = strtoupper( $_GET['order'] ?? 'DESC' ) === 'ASC' ? 'ASC' : 'DESC';

    $conditions = [];
    $binds = [];
    if ( $search !== '' ) {
        $conditions[] = "(u.keyword LIKE :s OR u.url LIKE :s OR u.title LIKE :s)";
        $binds['s'] = '%' . $search . '%';
    }
    if ( $tag_id > 0 ) {
        $conditions[] = "u.keyword IN (SELECT keyword FROM `$link_tags_table` WHERE tag_id = :tag_id)";
        $binds['tag_id'] = $tag_id;
    }
    $where = $conditions ? 'WHERE ' . implode( ' AND ', $conditions ) : '';

    $db = yourls_get_db( 'read-leanks_list' );

    $total = (int) $db->fetchValue( "SELECT COUNT(*) FROM `$table` u $where", $binds );
    $total_clicks = (int) $db->fetchValue( "SELECT COALESCE(SUM(u.clicks), 0) FROM `$table` u $where", $binds );

    $rows = $db->fetchObjects(
        "SELECT u.keyword, u.url, u.title, u.timestamp, u.ip, u.clicks,
                m.password_hash, m.expires_at, m.max_clicks,
                m.utm_source, m.utm_medium, m.utm_campaign, m.utm_term, m.utm_content
         FROM `$table` u
         LEFT JOIN `$meta_table` m ON m.keyword = u.keyword
         $where
         ORDER BY u.$sort $order
         LIMIT $perpage OFFSET $offset",
        $binds
    );

    $tagsByKeyword = leanks_get_tags_for_keywords( array_map( fn( $r ) => $r->keyword, $rows ) );

    $items = array_map( function ( $r ) use ( $tagsByKeyword ) {
        $expired = !empty( $r->expires_at ) && strtotime( $r->expires_at ) <= time();
        $limit_reached = !empty( $r->max_clicks ) && (int) $r->clicks >= (int) $r->max_clicks;
        return [
            'keyword'      => $r->keyword,
            'shorturl'     => yourls_link( $r->keyword ),
            'url'          => $r->url,
            'title'        => $r->title,
            'timestamp'    => $r->timestamp,
            'clicks'       => (int) $r->clicks,
            'has_password' => !empty( $r->password_hash ),
            'expires_at'   => $r->expires_at,
            'max_clicks'   => $r->max_clicks !== null ? (int) $r->max_clicks : null,
            'is_expired'   => $expired || $limit_reached,
            'utm'          => [
                'source'   => $r->utm_source,
                'medium'   => $r->utm_medium,
                'campaign' => $r->utm_campaign,
                'term'     => $r->utm_term,
                'content'  => $r->utm_content,
            ],
            'tags'         => $tagsByKeyword[ $r->keyword ] ?? [],
            'nonce_edit'   => yourls_create_nonce( 'edit-save_' . $r->keyword ),
            'nonce_delete' => yourls_create_nonce( 'delete-link_' . $r->keyword ),
        ];
    }, $rows );

    leanks_json( [
        'items'        => $items,
        'total'        => $total,
        'total_clicks' => $total_clicks,
        'page'         => $page,
        'perpage'      => $perpage,
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_list', 'leanks_ajax_list' );

/**
 * Create or update a link's extra metadata (password / expiration / UTM).
 * Used both right after creating a link and when editing an existing one.
 */
function leanks_ajax_save_meta() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '' );

    $keyword = yourls_sanitize_keyword( (string) ( $_POST['keyword'] ?? '' ) );
    if ( $keyword === '' || !yourls_get_keyword_longurl( $keyword ) ) {
        leanks_json( [ 'success' => false, 'message' => 'Unknown short URL' ] );
    }

    $fields = [];

    if ( isset( $_POST['remove_password'] ) && $_POST['remove_password'] === '1' ) {
        $fields['password_hash'] = null;
    } elseif ( !empty( $_POST['password'] ) ) {
        $fields['password_hash'] = password_hash( (string) $_POST['password'], PASSWORD_DEFAULT );
    }

    if ( array_key_exists( 'expires_at', $_POST ) ) {
        $expires = trim( (string) $_POST['expires_at'] );
        $fields['expires_at'] = $expires !== '' ? date( 'Y-m-d H:i:s', strtotime( $expires ) ) : null;
    }

    if ( array_key_exists( 'max_clicks', $_POST ) ) {
        $max = trim( (string) $_POST['max_clicks'] );
        $fields['max_clicks'] = $max !== '' ? max( 1, (int) $max ) : null;
    }

    foreach ( [ 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content' ] as $utm_field ) {
        if ( array_key_exists( $utm_field, $_POST ) ) {
            $val = trim( (string) $_POST[ $utm_field ] );
            $fields[ $utm_field ] = $val !== '' ? yourls_sanitize_title( $val ) : null;
        }
    }

    leanks_save_meta( $keyword, $fields );

    if ( array_key_exists( 'tag_ids', $_POST ) ) {
        leanks_set_link_tags( $keyword, leanks_parse_tag_ids( $_POST['tag_ids'] ) );
    }

    leanks_json( [ 'success' => true ] );
}
yourls_add_action( 'yourls_ajax_leanks_save_meta', 'leanks_ajax_save_meta' );

/**
 * Parses the comma-separated `tag_ids` form field the create/edit link form sends (e.g. "3,7,12").
 *
 * @return int[]
 */
function leanks_parse_tag_ids( $raw ) {
    $ids = array_map( 'intval', explode( ',', (string) $raw ) );
    return array_values( array_filter( $ids, fn( $id ) => $id > 0 ) );
}

/**
 * When a link is created through the stock admin-ajax "add" action, pick up any Leanks fields
 * (password / expiration / UTM) submitted alongside it in the same request.
 *
 * Actions in YOURLS bundle all their extra arguments into a single array passed as one
 * parameter -- unlike WordPress, extra args are NOT unpacked into separate function parameters.
 *
 * @param array $args [ $url, $keyword, $title, $return ]
 */
function leanks_on_new_link( $args ) {
    [ , , , $return ] = $args;
    if ( empty( $return['status'] ) || $return['status'] !== 'success' || empty( $return['url']['keyword'] ) ) {
        return;
    }
    $has_extra = !empty( $_POST['password'] ) || !empty( $_POST['expires_at'] ) || !empty( $_POST['max_clicks'] )
        || !empty( $_POST['utm_source'] ) || !empty( $_POST['utm_medium'] ) || !empty( $_POST['utm_campaign'] )
        || !empty( $_POST['utm_term'] ) || !empty( $_POST['utm_content'] ) || !empty( $_POST['tag_ids'] );
    if ( !$has_extra ) {
        return;
    }

    leanks_save_meta_from_request( $return['url']['keyword'] );
}
yourls_add_action( 'post_add_new_link', 'leanks_on_new_link' );

/**
 * Shared field-collection logic used by leanks_on_new_link (no nonce check needed there: the
 * request already passed the stock "add" action's own nonce check).
 */
function leanks_save_meta_from_request( $keyword ) {
    $fields = [];

    if ( !empty( $_POST['password'] ) ) {
        $fields['password_hash'] = password_hash( (string) $_POST['password'], PASSWORD_DEFAULT );
    }
    if ( !empty( $_POST['expires_at'] ) ) {
        $fields['expires_at'] = date( 'Y-m-d H:i:s', strtotime( (string) $_POST['expires_at'] ) );
    }
    if ( !empty( $_POST['max_clicks'] ) ) {
        $fields['max_clicks'] = max( 1, (int) $_POST['max_clicks'] );
    }
    foreach ( [ 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content' ] as $utm_field ) {
        if ( !empty( $_POST[ $utm_field ] ) ) {
            $fields[ $utm_field ] = yourls_sanitize_title( (string) $_POST[ $utm_field ] );
        }
    }

    leanks_save_meta( $keyword, $fields );

    if ( !empty( $_POST['tag_ids'] ) ) {
        leanks_set_link_tags( $keyword, leanks_parse_tag_ids( $_POST['tag_ids'] ) );
    }
}

/**
 * Per-link stats: click timeseries (last 30 days), top referrers, top countries.
 */
function leanks_ajax_stats() {
    $keyword = yourls_sanitize_keyword( (string) ( $_GET['keyword'] ?? '' ) );
    if ( $keyword === '' || !yourls_get_keyword_longurl( $keyword ) ) {
        leanks_json( [ 'success' => false, 'message' => 'Unknown short URL' ] );
    }

    $log = YOURLS_DB_TABLE_LOG;
    $db = yourls_get_db( 'read-leanks_stats' );

    $timeseries = $db->fetchPairs(
        "SELECT DATE(click_time) AS d, COUNT(*) AS c FROM `$log`
         WHERE shorturl = :k AND click_time >= :since
         GROUP BY DATE(click_time) ORDER BY d ASC",
        [ 'k' => $keyword, 'since' => date( 'Y-m-d H:i:s', strtotime( '-30 days' ) ) ]
    );

    $referrers = $db->fetchPairs(
        "SELECT referrer, COUNT(*) AS c FROM `$log` WHERE shorturl = :k
         GROUP BY referrer ORDER BY c DESC LIMIT 5",
        [ 'k' => $keyword ]
    );

    $countries = $db->fetchPairs(
        "SELECT country_code, COUNT(*) AS c FROM `$log` WHERE shorturl = :k AND country_code != ''
         GROUP BY country_code ORDER BY c DESC LIMIT 5",
        [ 'k' => $keyword ]
    );

    leanks_json( [
        'success'    => true,
        'clicks'     => (int) yourls_get_keyword_clicks( $keyword ),
        'timeseries' => $timeseries,
        'referrers'  => $referrers,
        'countries'  => $countries,
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_stats', 'leanks_ajax_stats' );

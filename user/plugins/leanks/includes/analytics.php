<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Backs the dashboard's Analytics page: a date-ranged, filterable overview (total clicks,
 * timeseries, and ranked breakdowns by link/destination/referrer/UTM/country/continent/
 * device/browser/OS) built entirely from the stock YOURLS click log table.
 *
 * The click log (`{prefix}yourls_log`) only stores click_time, shorturl, referrer, user_agent
 * (raw string) and country_code -- there's no device/browser/OS/continent column and no vendored
 * UA-parsing library, so those three dimensions are derived here with a small regex parser, and
 * continent is derived from country_code via a static map this plugin owns.
 */

const LEANKS_ANALYTICS_UA_SCAN_LIMIT = 20000;

if ( !defined( 'DAY_IN_SECONDS' ) ) {
    define( 'DAY_IN_SECONDS', 86400 );
}

/* ----------------------------------------------------------------------------------------------
 * Pure helpers (no DB)
 * ------------------------------------------------------------------------------------------- */

/**
 * Static ISO 3166-1 alpha-2 country_code -> continent name map. Owned by the plugin (YOURLS core's
 * includes/functions-geo.php only maps code -> country name, no continent).
 */
function leanks_analytics_continent_map() {
    static $map = null;
    if ( $map !== null ) {
        return $map;
    }

    $groups = [
        'Africa' => [ 'DZ','AO','BJ','BW','BF','BI','CV','CM','CF','TD','KM','CG','CD','CI','DJ','EG','GQ','ER','SZ','ET','GA','GM','GH','GN','GW','KE','LS','LR','LY','MG','MW','ML','MR','MU','YT','MA','MZ','NA','NE','NG','RE','RW','SH','ST','SN','SC','SL','SO','ZA','SS','SD','TZ','TG','TN','UG','EH','ZM','ZW' ],
        'Antarctica' => [ 'AQ','BV','TF','HM','GS' ],
        'Asia' => [ 'AF','AM','AZ','BH','BD','BT','BN','KH','CN','CY','GE','HK','IN','ID','IR','IQ','IL','JP','JO','KZ','KP','KR','KW','KG','LA','LB','MO','MY','MV','MN','MM','NP','OM','PK','PS','PH','QA','SA','SG','LK','SY','TW','TJ','TH','TL','TR','TM','AE','UZ','VN','YE' ],
        'Europe' => [ 'AX','AL','AD','AT','BY','BE','BA','BG','HR','CZ','DK','EE','FO','FI','FR','DE','GI','GR','GG','VA','HU','IS','IE','IM','IT','JE','XK','LV','LI','LT','LU','MT','MD','MC','ME','NL','MK','NO','PL','PT','RO','RU','SM','RS','SK','SI','ES','SJ','SE','CH','UA','GB' ],
        'North America' => [ 'AI','AG','AW','BS','BB','BZ','BM','BQ','CA','KY','CR','CU','CW','DM','DO','SV','GL','GD','GP','GT','HT','HN','JM','MQ','MX','MS','NI','PA','PR','BL','KN','LC','MF','PM','VC','SX','TT','TC','US','VG','VI' ],
        'Oceania' => [ 'AS','AU','CX','CC','CK','FJ','PF','GU','KI','MH','FM','NR','NC','NZ','NU','NF','MP','PW','PG','PN','WS','SB','TK','TO','TV','VU','WF' ],
        'South America' => [ 'AR','BO','BR','CL','CO','EC','FK','GF','GY','PY','PE','GS','SR','UY','VE' ],
    ];

    $map = [];
    foreach ( $groups as $continent => $codes ) {
        foreach ( $codes as $code ) {
            $map[ $code ] = $continent;
        }
    }
    return $map;
}

function leanks_analytics_country_continent( $code ) {
    $map = leanks_analytics_continent_map();
    return $map[ strtoupper( (string) $code ) ] ?? 'Other';
}

/**
 * Regex-based, from-scratch UA parser -- no library is vendored for this. Fixed vocabulary
 * (Desktop/Mobile/Tablet; Chrome/Safari/Firefox/Edge/Samsung Internet/Opera/Other; Windows/macOS/
 * iOS/Android/Linux/ChromeOS/Other) that the frontend's Device/Browser/OS filter dropdowns
 * hardcode as static option lists -- keep both in sync if this vocabulary ever changes.
 *
 * @return array{device:string,browser:string,os:string}
 */
function leanks_analytics_parse_ua( $ua ) {
    $ua = (string) $ua;

    if ( preg_match( '/iPad|Tablet/i', $ua ) || ( preg_match( '/Android/i', $ua ) && !preg_match( '/Mobile/i', $ua ) ) ) {
        $device = 'Tablet';
    } elseif ( preg_match( '/Mobile|iPhone|Windows Phone/i', $ua ) ) {
        $device = 'Mobile';
    } else {
        $device = 'Desktop';
    }

    if ( preg_match( '/Edg\//i', $ua ) ) {
        $browser = 'Edge';
    } elseif ( preg_match( '/SamsungBrowser\//i', $ua ) ) {
        $browser = 'Samsung Internet';
    } elseif ( preg_match( '/OPR\/|Opera/i', $ua ) ) {
        $browser = 'Opera';
    } elseif ( preg_match( '/Firefox\//i', $ua ) ) {
        $browser = 'Firefox';
    } elseif ( preg_match( '/Chrome\/|CriOS\//i', $ua ) ) {
        $browser = 'Chrome';
    } elseif ( preg_match( '/Safari\//i', $ua ) ) {
        $browser = 'Safari';
    } else {
        $browser = 'Other';
    }

    if ( preg_match( '/iPhone|iPad|iPod/i', $ua ) ) {
        $os = 'iOS';
    } elseif ( preg_match( '/Mac OS X/i', $ua ) ) {
        $os = 'macOS';
    } elseif ( preg_match( '/Windows NT/i', $ua ) ) {
        $os = 'Windows';
    } elseif ( preg_match( '/CrOS/i', $ua ) ) {
        $os = 'ChromeOS';
    } elseif ( preg_match( '/Android/i', $ua ) ) {
        $os = 'Android';
    } elseif ( preg_match( '/Linux/i', $ua ) ) {
        $os = 'Linux';
    } else {
        $os = 'Other';
    }

    return [ 'device' => $device, 'browser' => $browser, 'os' => $os ];
}

/**
 * Resolves a range key (+ optional custom bounds) to [since, until, bucket].
 * Bucket is derived from the actual day-span, not the label, so e.g. a narrow custom range still
 * buckets hourly and a long one still buckets weekly.
 *
 * @return array{0:string,1:string,2:string} [since 'Y-m-d H:i:s', until 'Y-m-d H:i:s', bucket 'hour'|'day'|'week']
 */
function leanks_analytics_resolve_range( $range, $start = '', $end = '' ) {
    $now = time();
    $until = date( 'Y-m-d H:i:s', $now );

    switch ( $range ) {
        case '24h':
            $since = date( 'Y-m-d H:i:s', $now - DAY_IN_SECONDS );
            break;
        case '7d':
            $since = date( 'Y-m-d H:i:s', $now - 7 * DAY_IN_SECONDS );
            break;
        case '30d':
            $since = date( 'Y-m-d H:i:s', $now - 30 * DAY_IN_SECONDS );
            break;
        case '3m':
            $since = date( 'Y-m-d H:i:s', strtotime( '-3 months', $now ) );
            break;
        case '12m':
            $since = date( 'Y-m-d H:i:s', strtotime( '-12 months', $now ) );
            break;
        case 'mtd':
            $since = date( 'Y-m-01 00:00:00', $now );
            break;
        case 'qtd':
            $quarterStartMonth = ( (int) floor( ( (int) date( 'n', $now ) - 1 ) / 3 ) * 3 ) + 1;
            $since = date( 'Y-' ) . str_pad( (string) $quarterStartMonth, 2, '0', STR_PAD_LEFT ) . '-01 00:00:00';
            break;
        case 'ytd':
            $since = date( 'Y-01-01 00:00:00', $now );
            break;
        case 'custom':
            $startTs = $start !== '' ? strtotime( $start . ' 00:00:00' ) : false;
            $endTs   = $end !== '' ? strtotime( $end . ' 23:59:59' ) : false;
            if ( $startTs === false || $endTs === false || $startTs > $endTs ) {
                $since = date( 'Y-m-d H:i:s', $now - 7 * DAY_IN_SECONDS );
            } else {
                $since = date( 'Y-m-d H:i:s', $startTs );
                $until = date( 'Y-m-d H:i:s', $endTs );
            }
            break;
        default:
            $since = date( 'Y-m-d H:i:s', $now - 7 * DAY_IN_SECONDS );
    }

    $spanDays = ( strtotime( $until ) - strtotime( $since ) ) / DAY_IN_SECONDS;
    if ( $spanDays <= 2 ) {
        $bucket = 'hour';
    } elseif ( $spanDays <= 90 ) {
        $bucket = 'day';
    } else {
        $bucket = 'week';
    }

    return [ $since, $until, $bucket ];
}

function leanks_analytics_bucket_sql( $bucket, $col = 'click_time' ) {
    switch ( $bucket ) {
        case 'hour':
            return "DATE_FORMAT(`$col`, '%Y-%m-%d %H:00:00')";
        case 'week':
            return "DATE_SUB(DATE(`$col`), INTERVAL WEEKDAY(`$col`) DAY)";
        default:
            return "DATE(`$col`)";
    }
}

function leanks_analytics_bucket_php( $click_time, $bucket ) {
    $ts = is_numeric( $click_time ) ? (int) $click_time : strtotime( (string) $click_time );
    switch ( $bucket ) {
        case 'hour':
            return date( 'Y-m-d H:00:00', $ts );
        case 'week':
            $weekday = (int) date( 'N', $ts ) - 1; // 0 = Monday
            return date( 'Y-m-d', $ts - $weekday * DAY_IN_SECONDS );
        default:
            return date( 'Y-m-d', $ts );
    }
}

/**
 * Fills gaps in a [bucket_key => count] map so the chart line has no missing points between
 * $since and $until at the given bucket step.
 */
function leanks_analytics_zero_fill( array $pairs, $since, $until, $bucket ) {
    $stepMap = [ 'hour' => 'PT1H', 'day' => 'P1D', 'week' => 'P1W' ];
    $step = $stepMap[ $bucket ] ?? 'P1D';

    $start = new DateTime( $since );
    $end = new DateTime( $until );
    $period = new DatePeriod( $start, new DateInterval( $step ), $end );

    $out = [];
    foreach ( $period as $dt ) {
        $key = leanks_analytics_bucket_php( $dt->getTimestamp(), $bucket );
        $out[ $key ] = (int) ( $pairs[ $key ] ?? 0 );
    }
    // Always include the final bucket too (DatePeriod's end is exclusive by default).
    $finalKey = leanks_analytics_bucket_php( $end->getTimestamp(), $bucket );
    if ( !array_key_exists( $finalKey, $out ) ) {
        $out[ $finalKey ] = (int) ( $pairs[ $finalKey ] ?? 0 );
    }

    $result = [];
    foreach ( $out as $t => $c ) {
        $result[] = [ 't' => $t, 'c' => $c ];
    }
    return $result;
}

/* ----------------------------------------------------------------------------------------------
 * Filtering
 * ------------------------------------------------------------------------------------------- */

/**
 * Builds the shared WHERE fragment + binds for date range + the SQL-pushable filters
 * (link/country/continent/referrer). Device/browser/os are deliberately excluded -- they're not
 * SQL columns, see leanks_ajax_analytics_overview() for how those are handled.
 *
 * @return array{0:string,1:array} [$sql, $binds]
 */
function leanks_analytics_build_where( array $filters, $since, $until, $alias = 'l' ) {
    $sql = "$alias.click_time BETWEEN :since AND :until";
    $binds = [ 'since' => $since, 'until' => $until ];

    if ( !empty( $filters['link'] ) ) {
        $sql .= " AND $alias.shorturl = :link";
        $binds['link'] = $filters['link'];
    }
    if ( !empty( $filters['country'] ) ) {
        $sql .= " AND $alias.country_code = :country";
        $binds['country'] = strtoupper( $filters['country'] );
    }
    if ( !empty( $filters['continent'] ) ) {
        $codes = array_keys( array_filter( leanks_analytics_continent_map(), fn( $c ) => $c === $filters['continent'] ) );
        if ( empty( $codes ) ) {
            $codes = [ '__none__' ]; // unknown continent name -> match nothing
        }
        $placeholders = [];
        foreach ( $codes as $i => $code ) {
            $key = "continent_$i";
            $placeholders[] = ":$key";
            $binds[ $key ] = $code;
        }
        $sql .= " AND $alias.country_code IN (" . implode( ',', $placeholders ) . ")";
    }
    if ( !empty( $filters['referrer'] ) ) {
        $sql .= " AND $alias.referrer = :referrer";
        $binds['referrer'] = $filters['referrer'];
    }

    return [ $sql, $binds ];
}

/* ----------------------------------------------------------------------------------------------
 * Overview: fast (SQL aggregate) path
 * ------------------------------------------------------------------------------------------- */

function leanks_analytics_overview_sql_path( array $filters, $since, $until, $bucket ) {
    $log = YOURLS_DB_TABLE_LOG;
    $url = YOURLS_DB_TABLE_URL;
    $meta = leanks_meta_table();
    $db = yourls_get_db( 'read-leanks_analytics' );

    [ $where, $binds ] = leanks_analytics_build_where( $filters, $since, $until );

    $clicks = (int) $db->fetchValue( "SELECT COUNT(*) FROM `$log` l WHERE $where", $binds );

    $bucketExpr = leanks_analytics_bucket_sql( $bucket );
    $tsPairs = $db->fetchPairs(
        "SELECT $bucketExpr AS bucket, COUNT(*) AS c FROM `$log` l WHERE $where GROUP BY bucket ORDER BY bucket",
        $binds
    );
    $timeseries = leanks_analytics_zero_fill( $tsPairs, $since, $until, $bucket );

    $shortLinkRows = $db->fetchPairs(
        "SELECT l.shorturl AS keyword, COUNT(*) AS c FROM `$log` l WHERE $where GROUP BY l.shorturl ORDER BY c DESC LIMIT 8",
        $binds
    );
    $shortLinks = [];
    foreach ( $shortLinkRows as $keyword => $c ) {
        $shortLinks[] = [ 'keyword' => $keyword, 'shorturl' => yourls_link( $keyword ), 'c' => (int) $c ];
    }

    $destRows = $db->fetchPairs(
        "SELECT u.url AS url, COUNT(*) AS c FROM `$log` l JOIN `$url` u ON u.keyword = l.shorturl
         WHERE $where GROUP BY u.url ORDER BY c DESC LIMIT 8",
        $binds
    );
    $destinationUrls = leanks_analytics_pairs_to_rows( $destRows, 'url' );

    $referrerRows = $db->fetchPairs(
        "SELECT l.referrer AS referrer, COUNT(*) AS c FROM `$log` l WHERE $where GROUP BY l.referrer ORDER BY c DESC LIMIT 8",
        $binds
    );
    $referrers = leanks_analytics_pairs_to_rows( $referrerRows, 'referrer' );

    $utm = [];
    foreach ( [ 'source', 'medium', 'campaign', 'term', 'content' ] as $field ) {
        $col = "utm_$field";
        $rows = $db->fetchPairs(
            "SELECT m.`$col` AS value, COUNT(*) AS c FROM `$log` l JOIN `$meta` m ON m.keyword = l.shorturl
             WHERE $where AND m.`$col` IS NOT NULL AND m.`$col` != '' GROUP BY m.`$col` ORDER BY c DESC LIMIT 8",
            $binds
        );
        $utm[ $field ] = leanks_analytics_pairs_to_rows( $rows, 'value' );
    }

    $countryRows = $db->fetchPairs(
        "SELECT l.country_code AS code, COUNT(*) AS c FROM `$log` l WHERE $where AND l.country_code != ''
         GROUP BY l.country_code ORDER BY c DESC LIMIT 8",
        $binds
    );
    $countries = leanks_analytics_pairs_to_rows( $countryRows, 'code' );

    $allCountryRows = $db->fetchPairs(
        "SELECT l.country_code AS code, COUNT(*) AS c FROM `$log` l WHERE $where AND l.country_code != '' GROUP BY l.country_code",
        $binds
    );
    $continents = leanks_analytics_collapse_continents( $allCountryRows );

    $uaRows = $db->fetchCol( "SELECT l.user_agent FROM `$log` l WHERE $where LIMIT " . LEANKS_ANALYTICS_UA_SCAN_LIMIT, $binds );
    [ $devices, $browsers, $os ] = leanks_analytics_tally_ua( $uaRows );

    return [
        'clicks' => $clicks,
        'timeseries' => $timeseries,
        'short_links' => $shortLinks,
        'destination_urls' => $destinationUrls,
        'referrers' => $referrers,
        'utm' => $utm,
        'countries' => $countries,
        'continents' => $continents,
        'devices' => $devices,
        'browsers' => $browsers,
        'os' => $os,
        'capped' => false,
    ];
}

/* ----------------------------------------------------------------------------------------------
 * Overview: capped raw-scan path (used when a device/browser/os filter is active)
 * ------------------------------------------------------------------------------------------- */

function leanks_analytics_overview_scan_path( array $filters, $since, $until, $bucket ) {
    $log = YOURLS_DB_TABLE_LOG;
    $db = yourls_get_db( 'read-leanks_analytics_scan' );

    [ $where, $binds ] = leanks_analytics_build_where( $filters, $since, $until );

    $rows = $db->fetchObjects(
        "SELECT click_time, shorturl, referrer, user_agent, country_code FROM `$log` l
         WHERE $where ORDER BY l.click_time ASC LIMIT " . ( LEANKS_ANALYTICS_UA_SCAN_LIMIT + 1 ),
        $binds
    );

    $capped = count( $rows ) > LEANKS_ANALYTICS_UA_SCAN_LIMIT;
    if ( $capped ) {
        $rows = array_slice( $rows, 0, LEANKS_ANALYTICS_UA_SCAN_LIMIT );
    }

    $wantDevice = $filters['device'] ?? '';
    $wantBrowser = $filters['browser'] ?? '';
    $wantOs = $filters['os'] ?? '';

    $matched = [];
    foreach ( $rows as $row ) {
        $ua = leanks_analytics_parse_ua( $row->user_agent );
        if ( $wantDevice !== '' && $ua['device'] !== $wantDevice ) continue;
        if ( $wantBrowser !== '' && $ua['browser'] !== $wantBrowser ) continue;
        if ( $wantOs !== '' && $ua['os'] !== $wantOs ) continue;
        $matched[] = [ 'row' => $row, 'ua' => $ua ];
    }

    // Preload link -> URL / UTM lookups needed for destination/UTM breakdowns, scoped to the
    // keywords actually present in the matched set (small, bounded by LEANKS_ANALYTICS_UA_SCAN_LIMIT).
    $keywords = array_values( array_unique( array_map( fn( $m ) => $m['row']->shorturl, $matched ) ) );
    $urlByKeyword = [];
    $metaByKeyword = [];
    if ( !empty( $keywords ) ) {
        $urlTable = YOURLS_DB_TABLE_URL;
        $metaTable = leanks_meta_table();
        $placeholders = [];
        $kwBinds = [];
        foreach ( $keywords as $i => $kw ) {
            $placeholders[] = ":kw_$i";
            $kwBinds[ "kw_$i" ] = $kw;
        }
        $in = implode( ',', $placeholders );

        $lookupDb = yourls_get_db( 'read-leanks_analytics_scan_lookup' );
        foreach ( $lookupDb->fetchObjects( "SELECT keyword, url FROM `$urlTable` WHERE keyword IN ($in)", $kwBinds ) as $u ) {
            $urlByKeyword[ $u->keyword ] = $u->url;
        }
        foreach ( $lookupDb->fetchObjects( "SELECT * FROM `$metaTable` WHERE keyword IN ($in)", $kwBinds ) as $m ) {
            $metaByKeyword[ $m->keyword ] = $m;
        }
    }

    $clicks = count( $matched );

    $tsPairs = [];
    $keywordCounts = [];
    $urlCounts = [];
    $referrerCounts = [];
    $utmCounts = [ 'source' => [], 'medium' => [], 'campaign' => [], 'term' => [], 'content' => [] ];
    $countryCounts = [];
    $deviceCounts = [];
    $browserCounts = [];
    $osCounts = [];

    foreach ( $matched as $m ) {
        $row = $m['row'];
        $ua = $m['ua'];

        $bucketKey = leanks_analytics_bucket_php( $row->click_time, $bucket );
        $tsPairs[ $bucketKey ] = ( $tsPairs[ $bucketKey ] ?? 0 ) + 1;

        $keywordCounts[ $row->shorturl ] = ( $keywordCounts[ $row->shorturl ] ?? 0 ) + 1;

        if ( isset( $urlByKeyword[ $row->shorturl ] ) ) {
            $u = $urlByKeyword[ $row->shorturl ];
            $urlCounts[ $u ] = ( $urlCounts[ $u ] ?? 0 ) + 1;
        }

        $referrerCounts[ $row->referrer ] = ( $referrerCounts[ $row->referrer ] ?? 0 ) + 1;

        if ( isset( $metaByKeyword[ $row->shorturl ] ) ) {
            $meta = $metaByKeyword[ $row->shorturl ];
            foreach ( [ 'source', 'medium', 'campaign', 'term', 'content' ] as $field ) {
                $val = $meta->{"utm_$field"} ?? null;
                if ( $val !== null && $val !== '' ) {
                    $utmCounts[ $field ][ $val ] = ( $utmCounts[ $field ][ $val ] ?? 0 ) + 1;
                }
            }
        }

        if ( $row->country_code !== '' ) {
            $countryCounts[ $row->country_code ] = ( $countryCounts[ $row->country_code ] ?? 0 ) + 1;
        }

        $deviceCounts[ $ua['device'] ] = ( $deviceCounts[ $ua['device'] ] ?? 0 ) + 1;
        $browserCounts[ $ua['browser'] ] = ( $browserCounts[ $ua['browser'] ] ?? 0 ) + 1;
        $osCounts[ $ua['os'] ] = ( $osCounts[ $ua['os'] ] ?? 0 ) + 1;
    }

    $shortLinks = [];
    foreach ( leanks_analytics_top( $keywordCounts, 8 ) as $keyword => $c ) {
        $shortLinks[] = [ 'keyword' => $keyword, 'shorturl' => yourls_link( $keyword ), 'c' => $c ];
    }

    $utm = [];
    foreach ( $utmCounts as $field => $counts ) {
        $utm[ $field ] = leanks_analytics_pairs_to_rows( leanks_analytics_top( $counts, 8 ), 'value' );
    }

    return [
        'clicks' => $clicks,
        'timeseries' => leanks_analytics_zero_fill( $tsPairs, $since, $until, $bucket ),
        'short_links' => $shortLinks,
        'destination_urls' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $urlCounts, 8 ), 'url' ),
        'referrers' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $referrerCounts, 8 ), 'referrer' ),
        'utm' => $utm,
        'countries' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $countryCounts, 8 ), 'code' ),
        'continents' => leanks_analytics_collapse_continents( $countryCounts ),
        'devices' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $deviceCounts, 8 ), 'name' ),
        'browsers' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $browserCounts, 8 ), 'name' ),
        'os' => leanks_analytics_pairs_to_rows( leanks_analytics_top( $osCounts, 8 ), 'name' ),
        'capped' => $capped,
    ];
}

/* ----------------------------------------------------------------------------------------------
 * Small shared aggregation utilities
 * ------------------------------------------------------------------------------------------- */

function leanks_analytics_pairs_to_rows( array $pairs, $keyName ) {
    $rows = [];
    foreach ( $pairs as $key => $c ) {
        $rows[] = [ $keyName => $key, 'c' => (int) $c ];
    }
    return $rows;
}

function leanks_analytics_top( array $counts, $limit ) {
    arsort( $counts );
    return array_slice( $counts, 0, $limit, true );
}

function leanks_analytics_tally_ua( array $userAgents ) {
    $devices = [];
    $browsers = [];
    $os = [];
    foreach ( $userAgents as $ua ) {
        $parsed = leanks_analytics_parse_ua( $ua );
        $devices[ $parsed['device'] ] = ( $devices[ $parsed['device'] ] ?? 0 ) + 1;
        $browsers[ $parsed['browser'] ] = ( $browsers[ $parsed['browser'] ] ?? 0 ) + 1;
        $os[ $parsed['os'] ] = ( $os[ $parsed['os'] ] ?? 0 ) + 1;
    }
    return [
        leanks_analytics_pairs_to_rows( leanks_analytics_top( $devices, 8 ), 'name' ),
        leanks_analytics_pairs_to_rows( leanks_analytics_top( $browsers, 8 ), 'name' ),
        leanks_analytics_pairs_to_rows( leanks_analytics_top( $os, 8 ), 'name' ),
    ];
}

function leanks_analytics_collapse_continents( array $countryCounts ) {
    $byContinent = [];
    foreach ( $countryCounts as $code => $c ) {
        $continent = leanks_analytics_country_continent( $code );
        $byContinent[ $continent ] = ( $byContinent[ $continent ] ?? 0 ) + (int) $c;
    }
    return leanks_analytics_pairs_to_rows( leanks_analytics_top( $byContinent, 8 ), 'name' );
}

/* ----------------------------------------------------------------------------------------------
 * Ajax endpoints
 * ------------------------------------------------------------------------------------------- */

function leanks_ajax_analytics_overview() {
    $range = (string) ( $_GET['range'] ?? '7d' );
    $start = (string) ( $_GET['start'] ?? '' );
    $end   = (string) ( $_GET['end'] ?? '' );

    [ $since, $until, $bucket ] = leanks_analytics_resolve_range( $range, $start, $end );

    $filters = [
        'link'      => trim( (string) ( $_GET['link'] ?? '' ) ),
        'country'   => trim( (string) ( $_GET['country'] ?? '' ) ),
        'continent' => trim( (string) ( $_GET['continent'] ?? '' ) ),
        'device'    => trim( (string) ( $_GET['device'] ?? '' ) ),
        'browser'   => trim( (string) ( $_GET['browser'] ?? '' ) ),
        'os'        => trim( (string) ( $_GET['os'] ?? '' ) ),
        'referrer'  => trim( (string) ( $_GET['referrer'] ?? '' ) ),
    ];

    $needsScan = $filters['device'] !== '' || $filters['browser'] !== '' || $filters['os'] !== '';

    $result = $needsScan
        ? leanks_analytics_overview_scan_path( $filters, $since, $until, $bucket )
        : leanks_analytics_overview_sql_path( $filters, $since, $until, $bucket );

    leanks_json( array_merge( [
        'success' => true,
        'range' => [ 'since' => $since, 'until' => $until, 'bucket' => $bucket ],
    ], $result ) );
}
yourls_add_action( 'yourls_ajax_leanks_analytics_overview', 'leanks_ajax_analytics_overview' );

/**
 * Option lists for the Country/Referrer filters. Device/Browser/OS/Continent are a fixed,
 * hardcoded vocabulary on the frontend (see leanks_analytics_parse_ua()'s docblock) and need no
 * endpoint; Country/Referrer are open-ended and would otherwise be limited to whatever's in the
 * top-8-capped breakdown panels.
 */
function leanks_ajax_analytics_filter_options() {
    $log = YOURLS_DB_TABLE_LOG;
    $db = yourls_get_db( 'read-leanks_analytics_filter_options' );

    leanks_json( [
        'success' => true,
        'countries' => $db->fetchCol( "SELECT DISTINCT country_code FROM `$log` WHERE country_code != '' ORDER BY country_code LIMIT 200" ),
        'referrers' => $db->fetchCol( "SELECT DISTINCT referrer FROM `$log` WHERE referrer != '' ORDER BY referrer LIMIT 200" ),
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_analytics_filter_options', 'leanks_ajax_analytics_filter_options' );

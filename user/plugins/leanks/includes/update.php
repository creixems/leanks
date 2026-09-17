<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Self-update engine: checks GitHub Releases for a newer tagged version of LEANKS_UPDATE_REPO,
 * and -- only on an explicit authenticated admin click -- downloads the release zip, verifies
 * its published SHA256 checksum, backs up every file about to be touched, then applies the
 * diff between the previously-installed manifest and the new release's manifest.
 *
 * Every release asset URL is host-validated against a small allowlist before it's ever fetched
 * (see leanks_update_is_allowed_asset_host()); no user-supplied URL is ever used anywhere in
 * this flow. `.htaccess` is intentionally never auto-overwritten -- see
 * leanks_update_check_htaccess_drift().
 */

const LEANKS_UPDATE_CHECK_INTERVAL = 86400; // 24h, mirrors YOURLS' own core-update check throttle
const LEANKS_UPDATE_LOCK_MAX_AGE   = 600;   // 10 minutes

// ---------- paths ----------

function leanks_update_work_dir() {
    return YOURLS_ABSPATH . '/user/leanks-updates';
}
function leanks_update_tmp_dir() {
    return leanks_update_work_dir() . '/tmp';
}
function leanks_update_backups_dir() {
    return leanks_update_work_dir() . '/backups';
}
function leanks_update_lock_file() {
    return leanks_update_work_dir() . '/update.lock';
}

function leanks_update_ensure_dirs() {
    foreach ( [ leanks_update_work_dir(), leanks_update_tmp_dir(), leanks_update_backups_dir() ] as $dir ) {
        if ( !is_dir( $dir ) ) {
            @mkdir( $dir, 0755, true );
        }
    }
}

// ---------- remote fetch helpers ----------

function leanks_update_http_headers() {
    return [
        'Accept' => 'application/vnd.github+json',
    ];
}

/**
 * Only ever trust release assets served directly from GitHub's own hosts. Every asset URL that
 * comes back from the GitHub API response is checked against this before it's fetched.
 */
function leanks_update_is_allowed_asset_host( $url ) {
    if ( !is_string( $url ) || $url === '' ) {
        return false;
    }
    if ( parse_url( $url, PHP_URL_SCHEME ) !== 'https' ) {
        return false;
    }
    $host = strtolower( (string) parse_url( $url, PHP_URL_HOST ) );
    return in_array( $host, [ 'github.com', 'api.github.com', 'objects.githubusercontent.com', 'codeload.github.com' ], true );
}

function leanks_update_http_get_body_strict( $url, $timeout = 15 ) {
    if ( !leanks_update_is_allowed_asset_host( $url ) ) {
        throw new \RuntimeException( 'Refused to fetch from an unexpected host.' );
    }
    $body = yourls_http_get_body( $url, leanks_update_http_headers(), [], [ 'timeout' => $timeout, 'follow_redirects' => true, 'redirects' => 5 ] );
    if ( $body === null || $body === '' ) {
        throw new \RuntimeException( 'Could not download a required file from GitHub.' );
    }
    return $body;
}

function leanks_update_download_to_file( $url, $dest_path ) {
    if ( !leanks_update_is_allowed_asset_host( $url ) ) {
        throw new \RuntimeException( 'Refused to fetch from an unexpected host.' );
    }
    $response = yourls_http_get( $url, leanks_update_http_headers(), [], [ 'timeout' => 30, 'follow_redirects' => true, 'redirects' => 5 ] );
    if ( !isset( $response->body ) || $response->body === '' ) {
        throw new \RuntimeException( 'Could not download the update package.' );
    }
    if ( file_put_contents( $dest_path, $response->body ) === false ) {
        throw new \RuntimeException( 'Could not write the downloaded update package to disk.' );
    }
}

// ---------- version check (read-only) ----------

function leanks_update_empty_result( $error = null ) {
    return [
        'current'          => LEANKS_VERSION,
        'latest'           => LEANKS_VERSION,
        'update_available' => false,
        'html_url'         => '',
        'changelog'        => '',
        'error'            => $error,
    ];
}

function leanks_update_result_from_cache( $cached ) {
    if ( !is_array( $cached ) || empty( $cached['version'] ) ) {
        return leanks_update_empty_result();
    }
    $assets = $cached['assets'] ?? [];
    $available = !empty( $assets['zip'] ) && !empty( $assets['manifest'] ) && !empty( $assets['sha256'] )
        && version_compare( $cached['version'], LEANKS_VERSION, '>' );
    return [
        'current'          => LEANKS_VERSION,
        'latest'           => $cached['version'],
        'update_available' => $available,
        'html_url'         => $cached['html_url'] ?? '',
        'changelog'        => $cached['changelog'] ?? '',
        'error'            => null,
    ];
}

/**
 * Checks the GitHub Releases API for the latest published release, throttled to once per
 * LEANKS_UPDATE_CHECK_INTERVAL unless $force is true. On any failure, falls back to the last
 * known-good cached result rather than flapping the "update available" banner off.
 */
function leanks_update_check( $force = false ) {
    $cached = yourls_get_option( 'leanks_update_latest_known', null );
    $last_checked = (int) yourls_get_option( 'leanks_update_last_checked', 0 );
    $now = time();

    if ( !$force && $cached && ( $now - $last_checked ) < LEANKS_UPDATE_CHECK_INTERVAL ) {
        return leanks_update_result_from_cache( $cached );
    }

    $url = 'https://api.github.com/repos/' . LEANKS_UPDATE_REPO . '/releases/latest';
    $body = yourls_http_get_body( $url, leanks_update_http_headers(), [], [ 'timeout' => 5 ] );

    yourls_update_option( 'leanks_update_last_checked', $now );

    if ( !$body ) {
        return $cached ? leanks_update_result_from_cache( $cached ) : leanks_update_empty_result( 'Could not reach GitHub.' );
    }

    $data = json_decode( $body, true );
    if ( !is_array( $data ) || empty( $data['tag_name'] ) ) {
        return $cached ? leanks_update_result_from_cache( $cached ) : leanks_update_empty_result( 'Unexpected response from GitHub.' );
    }

    $tag = ltrim( (string) $data['tag_name'], 'v' );
    $assets = [];
    foreach ( (array) ( $data['assets'] ?? [] ) as $asset ) {
        $name = (string) ( $asset['name'] ?? '' );
        $asset_url = (string) ( $asset['browser_download_url'] ?? '' );
        if ( $name === '' || !leanks_update_is_allowed_asset_host( $asset_url ) ) {
            continue;
        }
        if ( str_ends_with( $name, '.zip' ) ) {
            $assets['zip'] = $asset_url;
        } elseif ( str_ends_with( $name, '.manifest.json' ) ) {
            $assets['manifest'] = $asset_url;
        } elseif ( str_ends_with( $name, '.sha256' ) ) {
            $assets['sha256'] = $asset_url;
        }
    }

    $html_url = (string) ( $data['html_url'] ?? '' );
    $result = [
        'version'   => $tag,
        'html_url'  => leanks_update_is_allowed_asset_host( $html_url ) ? $html_url : ( 'https://github.com/' . LEANKS_UPDATE_REPO . '/releases' ),
        'changelog' => (string) ( $data['body'] ?? '' ),
        'assets'    => $assets,
    ];

    yourls_update_option( 'leanks_update_latest_known', $result );

    return leanks_update_result_from_cache( $result );
}

function leanks_ajax_check_update() {
    leanks_json( leanks_update_check() );
}
yourls_add_action( 'yourls_ajax_leanks_check_update', 'leanks_ajax_check_update' );

// ---------- update execution (mutating) ----------

function leanks_update_preflight_checks() {
    $writable = true;
    foreach ( [ 'admin', 'app', 'includes', 'setup', 'user/plugins/leanks' ] as $rel ) {
        if ( !is_writable( YOURLS_ABSPATH . '/' . $rel ) ) {
            $writable = false;
            break;
        }
    }

    $free = @disk_free_space( YOURLS_ABSPATH );

    return [
        'PHP zip extension (ZipArchive)' => class_exists( 'ZipArchive' ),
        'Install directories are writable' => $writable,
        'Enough free disk space' => $free === false ? true : $free > 50 * 1024 * 1024,
    ];
}

function leanks_update_acquire_lock() {
    leanks_update_ensure_dirs();
    $lock = leanks_update_lock_file();
    if ( file_exists( $lock ) && ( time() - (int) file_get_contents( $lock ) ) < LEANKS_UPDATE_LOCK_MAX_AGE ) {
        return false;
    }
    file_put_contents( $lock, (string) time() );
    return true;
}

function leanks_update_release_lock() {
    @unlink( leanks_update_lock_file() );
}

/**
 * Defense in depth against a compromised/malformed manifest: reject anything that isn't a
 * plain relative path, and explicitly refuse our own excluded paths even though they should
 * never legitimately appear in a manifest.
 */
function leanks_update_sanitize_manifest_path( $rel ) {
    $rel = str_replace( '\\', '/', (string) $rel );
    $rel = ltrim( $rel, '/' );
    if ( $rel === '' || strpos( $rel, '..' ) !== false ) {
        return null;
    }
    if ( $rel === 'user/config.php' || strpos( $rel, 'user/leanks-updates/' ) === 0 ) {
        return null;
    }
    return $rel;
}

function leanks_update_rrmdir( $dir ) {
    if ( !is_dir( $dir ) ) {
        return;
    }
    $items = new \RecursiveIteratorIterator(
        new \RecursiveDirectoryIterator( $dir, \FilesystemIterator::SKIP_DOTS ),
        \RecursiveIteratorIterator::CHILD_FIRST
    );
    foreach ( $items as $item ) {
        $item->isDir() ? @rmdir( $item->getPathname() ) : @unlink( $item->getPathname() );
    }
    @rmdir( $dir );
}

function leanks_update_extract_zip( $zip_path, $dest_dir ) {
    $zip = new \ZipArchive();
    if ( $zip->open( $zip_path ) !== true ) {
        throw new \RuntimeException( 'Could not open the downloaded update package.' );
    }
    if ( !is_dir( $dest_dir ) ) {
        mkdir( $dest_dir, 0755, true );
    }
    $ok = $zip->extractTo( $dest_dir );
    $zip->close();
    if ( !$ok ) {
        throw new \RuntimeException( 'Could not extract the update package.' );
    }
}

const LEANKS_BACKUP_META_ENTRY = '__leanks_backup_meta.json';

/**
 * Zips up every file in $manifest (the manifest of what's *currently* live) into a timestamped
 * backup before anything is overwritten, and prunes old backups down to the 3 most recent.
 *
 * $added_by_update -- paths this update is about to create that don't exist in $manifest (and so
 * have nothing to back up). Recorded inside the zip so a later restore can delete them too,
 * making restore a full undo rather than just "put the old files back".
 */
function leanks_update_backup_current( array $manifest, $from_version, array $added_by_update = [] ) {
    leanks_update_ensure_dirs();
    $backup_path = leanks_update_backups_dir() . '/backup-' . $from_version . '-' . date( 'Ymd-His' ) . '.zip';

    $zip = new \ZipArchive();
    if ( $zip->open( $backup_path, \ZipArchive::CREATE | \ZipArchive::OVERWRITE ) !== true ) {
        throw new \RuntimeException( 'Could not create a backup before updating -- aborting, nothing was changed.' );
    }
    foreach ( $manifest as $rel ) {
        $rel = leanks_update_sanitize_manifest_path( $rel );
        if ( $rel === null ) {
            continue;
        }
        $full = YOURLS_ABSPATH . '/' . $rel;
        if ( is_file( $full ) ) {
            $zip->addFile( $full, $rel );
        }
    }
    $zip->addFromString( LEANKS_BACKUP_META_ENTRY, json_encode( [ 'added_by_update' => array_values( $added_by_update ) ] ) );
    $zip->close();

    $backups = glob( leanks_update_backups_dir() . '/backup-*.zip' ) ?: [];
    if ( count( $backups ) > 3 ) {
        usort( $backups, fn( $a, $b ) => filemtime( $b ) <=> filemtime( $a ) );
        foreach ( array_slice( $backups, 3 ) as $old ) {
            @unlink( $old );
        }
    }

    return $backup_path;
}

/**
 * `.htaccess` is never auto-applied even when it's part of the release manifest: an admin's
 * hand-customized rewrite rules are exactly the kind of thing a silent overwrite would quietly
 * destroy. If the release's version differs from what's live, the new version is saved
 * alongside for manual review instead.
 */
function leanks_update_check_htaccess_drift( $extract_dir ) {
    $new_htaccess = $extract_dir . '/.htaccess';
    if ( !is_file( $new_htaccess ) ) {
        return null;
    }
    $live_htaccess = YOURLS_ABSPATH . '/.htaccess';
    if ( is_file( $live_htaccess ) && file_get_contents( $live_htaccess ) === file_get_contents( $new_htaccess ) ) {
        return null;
    }
    leanks_update_ensure_dirs();
    @copy( $new_htaccess, leanks_update_work_dir() . '/htaccess.new' );
    return '.htaccess changed upstream and was left untouched -- the new version was saved to user/leanks-updates/htaccess.new for you to review and merge by hand.';
}

function leanks_update_diff_manifests( array $old_manifest, array $new_manifest ) {
    $old = array_values( array_unique( array_filter( array_map( 'leanks_update_sanitize_manifest_path', $old_manifest ) ) ) );
    $new = array_values( array_unique( array_filter( array_map( 'leanks_update_sanitize_manifest_path', $new_manifest ) ) ) );

    $write  = array_values( array_filter( $new, fn( $p ) => $p !== '.htaccess' ) );
    $remove = array_values( array_filter( array_diff( $old, $new ), fn( $p ) => $p !== '.htaccess' ) );
    $added  = array_values( array_filter( array_diff( $new, $old ), fn( $p ) => $p !== '.htaccess' ) );

    return [ 'write' => $write, 'remove' => $remove, 'added' => $added ];
}

function leanks_update_apply_diff( array $diff, $extract_dir ) {
    $updated = 0;
    $added = 0;
    $removed = 0;

    foreach ( $diff['write'] as $rel ) {
        $src = $extract_dir . '/' . $rel;
        if ( !is_file( $src ) ) {
            continue;
        }
        $dest = YOURLS_ABSPATH . '/' . $rel;
        $existed = is_file( $dest );
        $dest_dir = dirname( $dest );
        if ( !is_dir( $dest_dir ) && !mkdir( $dest_dir, 0755, true ) ) {
            throw new \RuntimeException( "Could not create directory for $rel." );
        }
        if ( !copy( $src, $dest ) ) {
            throw new \RuntimeException( "Could not write $rel." );
        }
        $existed ? $updated++ : $added++;
    }

    foreach ( $diff['remove'] as $rel ) {
        $dest = YOURLS_ABSPATH . '/' . $rel;
        if ( is_file( $dest ) && @unlink( $dest ) ) {
            $removed++;
        }
    }

    return [
        'updated' => $updated,
        'added' => $added,
        'removed' => $removed,
        'htaccess_note' => leanks_update_check_htaccess_drift( $extract_dir ),
    ];
}

/**
 * Restores live files from a backup zip made by leanks_update_backup_current(). Used both for
 * an automatic rollback when applying an update fails partway through, and for the manual
 * "Restore previous version" action.
 */
function leanks_update_restore_from_backup( $backup_path ) {
    if ( !is_file( $backup_path ) ) {
        throw new \RuntimeException( 'Backup file not found.' );
    }
    $zip = new \ZipArchive();
    if ( $zip->open( $backup_path ) !== true ) {
        throw new \RuntimeException( 'Could not open backup file.' );
    }

    $meta_raw = $zip->getFromName( LEANKS_BACKUP_META_ENTRY );
    $meta = $meta_raw !== false ? json_decode( $meta_raw, true ) : null;
    $added_by_update = is_array( $meta ) ? ( $meta['added_by_update'] ?? [] ) : [];

    for ( $i = 0; $i < $zip->numFiles; $i++ ) {
        $name = $zip->getNameIndex( $i );
        if ( $name === LEANKS_BACKUP_META_ENTRY ) {
            continue;
        }
        $rel = leanks_update_sanitize_manifest_path( $name );
        if ( $rel === null || $rel === '.htaccess' ) {
            continue;
        }
        $dest = YOURLS_ABSPATH . '/' . $rel;
        $dest_dir = dirname( $dest );
        if ( !is_dir( $dest_dir ) ) {
            @mkdir( $dest_dir, 0755, true );
        }
        $contents = $zip->getFromIndex( $i );
        if ( $contents !== false ) {
            file_put_contents( $dest, $contents );
        }
    }

    // Full undo, not just "put the old files back": also remove whatever the update being
    // rolled back had newly created, so a restore doesn't leave orphaned new files behind.
    foreach ( $added_by_update as $rel ) {
        $rel = leanks_update_sanitize_manifest_path( $rel );
        if ( $rel === null || $rel === '.htaccess' ) {
            continue;
        }
        @unlink( YOURLS_ABSPATH . '/' . $rel );
    }
    $zip->close();
}

/**
 * The full update flow. Nothing live is touched until the download is verified against its
 * published checksum and a backup of the current install has been made successfully.
 */
function leanks_ajax_run_update() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '', 'leanks_run_update' );

    $failed = array_keys( array_filter( leanks_update_preflight_checks(), fn( $ok ) => !$ok ) );
    if ( !empty( $failed ) ) {
        leanks_json( [ 'success' => false, 'message' => 'Pre-flight checks failed: ' . implode( ', ', $failed ) ] );
    }

    if ( !leanks_update_acquire_lock() ) {
        leanks_json( [ 'success' => false, 'message' => 'An update is already in progress (or a previous run left a stale lock -- try again in a few minutes).' ] );
    }

    $started = microtime( true );

    try {
        $check = leanks_update_check( true );
        if ( empty( $check['update_available'] ) ) {
            throw new \RuntimeException( 'No update available.' );
        }

        $cached = yourls_get_option( 'leanks_update_latest_known', [] );
        $assets = $cached['assets'] ?? [];
        if ( empty( $assets['zip'] ) || empty( $assets['manifest'] ) || empty( $assets['sha256'] ) ) {
            throw new \RuntimeException( 'Release is missing expected files.' );
        }

        $old_version = LEANKS_VERSION;
        $new_version = $cached['version'];

        $new_manifest = json_decode( leanks_update_http_get_body_strict( $assets['manifest'] ), true );
        if ( !is_array( $new_manifest ) || empty( $new_manifest ) ) {
            throw new \RuntimeException( 'Could not read the release manifest.' );
        }

        // sha256sum-style output is "<hash>  <filename>" -- keep just the leading hex digest.
        $sha_body = trim( leanks_update_http_get_body_strict( $assets['sha256'] ) );
        $expected_sha = strtolower( preg_replace( '/\s.*$/s', '', $sha_body ) );
        if ( strlen( $expected_sha ) !== 64 ) {
            throw new \RuntimeException( 'Could not read the release checksum.' );
        }

        leanks_update_ensure_dirs();
        $zip_path = leanks_update_tmp_dir() . '/leanks-' . $new_version . '.zip';
        leanks_update_download_to_file( $assets['zip'], $zip_path );

        $actual_sha = (string) hash_file( 'sha256', $zip_path );
        if ( !hash_equals( $expected_sha, $actual_sha ) ) {
            @unlink( $zip_path );
            throw new \RuntimeException( 'Checksum verification failed -- the download may be corrupted or tampered with. Nothing was changed.' );
        }

        $extract_dir = leanks_update_tmp_dir() . '/extracted';
        leanks_update_rrmdir( $extract_dir );
        leanks_update_extract_zip( $zip_path, $extract_dir );

        foreach ( [ 'includes', 'app', 'admin' ] as $expected ) {
            if ( !is_dir( $extract_dir . '/' . $expected ) ) {
                throw new \RuntimeException( "Extracted release looks incomplete (missing $expected/)." );
            }
        }

        // Nothing live has been touched up to this point. From here on, failures attempt an
        // automatic rollback from the backup we're about to make.
        $old_manifest = yourls_get_option( 'leanks_installed_manifest', null );
        if ( !is_array( $old_manifest ) || empty( $old_manifest ) ) {
            // First automated update on this install: there's no recorded baseline of what was
            // originally shipped, so we can't safely know which live files to delete. Treat the
            // new manifest as the backup/diff baseline too -- this update will only add/overwrite,
            // never delete. Accurate deletion diffing starts from the next automated update.
            $old_manifest = $new_manifest;
        }

        $diff = leanks_update_diff_manifests( $old_manifest, $new_manifest );
        $backup_path = leanks_update_backup_current( $old_manifest, $old_version, $diff['added'] );

        try {
            $result = leanks_update_apply_diff( $diff, $extract_dir );
            leanks_run_migrations();

            yourls_update_option( 'leanks_installed_manifest', $new_manifest );
            yourls_update_option( 'leanks_installed_version', $new_version );
        } catch ( \Throwable $apply_error ) {
            leanks_update_restore_from_backup( $backup_path );
            throw new \RuntimeException( 'Update failed while applying files (automatically restored from backup): ' . $apply_error->getMessage() );
        }

        leanks_update_rrmdir( leanks_update_tmp_dir() );
        leanks_update_release_lock();

        leanks_json( [
            'success'       => true,
            'from_version'  => $old_version,
            'to_version'    => $new_version,
            'updated'       => $result['updated'],
            'added'         => $result['added'],
            'removed'       => $result['removed'],
            'htaccess_note' => $result['htaccess_note'],
            'backup'        => basename( $backup_path ),
            'duration'      => round( microtime( true ) - $started, 1 ),
        ] );
    } catch ( \Throwable $e ) {
        leanks_update_release_lock();
        leanks_json( [ 'success' => false, 'message' => $e->getMessage() ] );
    }
}
yourls_add_action( 'yourls_ajax_leanks_run_update', 'leanks_ajax_run_update' );

// ---------- backups ----------

function leanks_ajax_list_backups() {
    leanks_update_ensure_dirs();
    $files = glob( leanks_update_backups_dir() . '/backup-*.zip' ) ?: [];
    usort( $files, fn( $a, $b ) => filemtime( $b ) <=> filemtime( $a ) );
    leanks_json( [
        'backups' => array_map( fn( $f ) => [
            'file'    => basename( $f ),
            'size'    => filesize( $f ),
            'created' => date( 'Y-m-d H:i:s', filemtime( $f ) ),
        ], $files ),
    ] );
}
yourls_add_action( 'yourls_ajax_leanks_list_backups', 'leanks_ajax_list_backups' );

function leanks_ajax_restore_backup() {
    leanks_verify_nonce_json( $_POST['nonce'] ?? '', 'leanks_run_update' );

    $requested = basename( (string) ( $_POST['file'] ?? '' ) );
    leanks_update_ensure_dirs();

    $match = null;
    foreach ( glob( leanks_update_backups_dir() . '/backup-*.zip' ) ?: [] as $f ) {
        if ( basename( $f ) === $requested ) {
            $match = $f;
            break;
        }
    }
    if ( !$match ) {
        leanks_json( [ 'success' => false, 'message' => 'Backup not found.' ] );
    }

    if ( !leanks_update_acquire_lock() ) {
        leanks_json( [ 'success' => false, 'message' => 'An update/restore is already in progress.' ] );
    }

    try {
        leanks_update_restore_from_backup( $match );
        leanks_update_release_lock();
        leanks_json( [ 'success' => true ] );
    } catch ( \Throwable $e ) {
        leanks_update_release_lock();
        leanks_json( [ 'success' => false, 'message' => $e->getMessage() ] );
    }
}
yourls_add_action( 'yourls_ajax_leanks_restore_backup', 'leanks_ajax_restore_backup' );

<?php
// No direct call
if ( !defined( 'YOURLS_ABSPATH' ) ) die();

/**
 * Single source of truth for the installed Leanks version. Bumped on every tagged release;
 * the release workflow (.github/workflows/release.yml) fails the build if this doesn't match
 * the pushed git tag, so the two can't drift apart.
 */
define( 'LEANKS_VERSION', '1.1.0' );

/**
 * GitHub repo that ships official releases. Hardcoded on purpose -- update-checking always
 * requires an explicit admin click to apply, so a fork's admin who doesn't want upstream
 * updates simply never clicks it.
 */
define( 'LEANKS_UPDATE_REPO', 'creixems/leanks' );

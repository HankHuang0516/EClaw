/**
 * Upload AAB to Google Play Console
 *
 * Usage:
 *   node scripts/upload_to_play.js [--track=TRACK] [--promote] [path-to-aab]
 *
 * Tracks:
 *   --track=internal     Internal testing (default)
 *   --track=production   Production (submit for Google review)
 *
 * Options:
 *   --promote            Skip upload, promote latest internal version to target track
 *
 * If no AAB path is given, it looks for:
 *   app/build/outputs/bundle/release/app-release.aab
 *
 * Requires: play-service-account.json in project root
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const PACKAGE_NAME = 'com.hank.clawlive';
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', 'play-service-account.json');
const DEFAULT_AAB_PATH = path.join(__dirname, '..', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');

const TRACK_CONFIG = {
    internal: { status: 'completed', label: 'Internal Testing (內部測試)' },
    production: { status: 'completed', label: 'Production (正式版 - 提交審查)' },
};

function parseArgs() {
    let track = 'internal';
    let aabPath = DEFAULT_AAB_PATH;
    let promote = false;

    for (const arg of process.argv.slice(2)) {
        if (arg.startsWith('--track=')) {
            track = arg.split('=')[1];
        } else if (arg === '--promote') {
            promote = true;
        } else if (!arg.startsWith('--')) {
            aabPath = arg;
        }
    }

    if (!TRACK_CONFIG[track]) {
        console.error(`ERROR: Unknown track "${track}". Available: ${Object.keys(TRACK_CONFIG).join(', ')}`);
        process.exit(1);
    }

    return { track, aabPath, promote };
}

async function main() {
    const { track, aabPath, promote } = parseArgs();
    const config = TRACK_CONFIG[track];

    // Validate service account
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
        console.error('ERROR: play-service-account.json not found in project root');
        process.exit(1);
    }

    // Authenticate
    console.log(`\n=== Google Play ${promote ? 'Promote' : 'Upload'} ===`);
    console.log(`Package:  ${PACKAGE_NAME}`);
    console.log(`Track:    ${config.label}`);
    console.log(`Mode:     ${promote ? 'Promote (no upload)' : 'Upload + Assign'}`);
    console.log();

    console.log('[1/4] Authenticating with service account...');
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_ACCOUNT_PATH,
        scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    const play = google.androidpublisher({ version: 'v3', auth });

    // Create edit
    console.log('[2/4] Creating edit...');
    const { data: edit } = await play.edits.insert({
        packageName: PACKAGE_NAME,
        requestBody: {},
    });
    const editId = edit.id;
    console.log(`       Edit ID: ${editId}`);

    let versionCode;

    if (promote) {
        // Get latest version from internal track
        console.log('[3/4] Reading internal track for latest version...');
        const { data: trackData } = await play.edits.tracks.get({
            packageName: PACKAGE_NAME,
            editId,
            track: 'internal',
        });
        const releases = trackData.releases || [];
        const activeRelease = releases.find(r => r.status === 'completed') || releases[0];
        if (!activeRelease || !activeRelease.versionCodes || activeRelease.versionCodes.length === 0) {
            console.error('ERROR: No active release found on internal track. Upload to internal first.');
            process.exit(1);
        }
        versionCode = activeRelease.versionCodes[activeRelease.versionCodes.length - 1];
        console.log(`       Found version code: ${versionCode}`);
    } else {
        // Upload AAB
        if (!fs.existsSync(aabPath)) {
            console.error(`ERROR: AAB file not found at ${aabPath}`);
            console.error('Run ./gradlew.bat bundleRelease first');
            process.exit(1);
        }
        const aabSize = (fs.statSync(aabPath).size / 1024 / 1024).toFixed(1);
        console.log(`[3/4] Uploading AAB (${aabSize} MB)...`);
        const { data: bundle } = await play.edits.bundles.upload({
            packageName: PACKAGE_NAME,
            editId,
            media: {
                mimeType: 'application/octet-stream',
                body: fs.createReadStream(aabPath),
            },
        });
        versionCode = bundle.versionCode;
        console.log(`       Version code: ${versionCode}`);
    }

    // Assign to track
    console.log(`[4/4] Assigning to ${track} track...`);
    await play.edits.tracks.update({
        packageName: PACKAGE_NAME,
        editId,
        track,
        requestBody: {
            track,
            releases: [{
                versionCodes: [versionCode],
                status: config.status,
            }],
        },
    });

    // Commit edit
    await play.edits.commit({
        packageName: PACKAGE_NAME,
        editId,
        changesNotSentForReview: true,
    });

    console.log(`\n=== SUCCESS ===`);
    console.log(`Version code ${versionCode} → ${config.label}`);
    if (track === 'production') {
        console.log(`Google will review your app. Check status in Google Play Console.`);
    }
    console.log(`Check: https://play.google.com/console → E-Claw\n`);
}

main().catch(err => {
    console.error('\nUpload failed:', err.message);
    if (err.errors) {
        err.errors.forEach(e => console.error(' -', e.message));
    }
    process.exit(1);
});

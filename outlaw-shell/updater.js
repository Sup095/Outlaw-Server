// ============================================================================
// Outlaw OS - OTA self-updater
// ----------------------------------------------------------------------------
// Pulls release metadata from the GitHub REST API, compares semver, downloads
// the shell tarball + its checksum file, verifies SHA256, and hands off to a
// privileged installer (outlaw-update-apply) for an atomic swap. No third
// party SDKs — only Node built-ins and the runtime fetch.
// ============================================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function normalize(v) { return String(v || '0').replace(/^v/i, '').trim(); }

function compareVersions(a, b) {
    const A = normalize(a).split('.').map((n) => parseInt(n, 10) || 0);
    const B = normalize(b).split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(A.length, B.length);
    for (let i = 0; i < len; i++) {
        const d = (A[i] || 0) - (B[i] || 0);
        if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
}

async function ghFetch(url, opts = {}) {
    const res = await fetch(url, {
        redirect: 'follow',
        headers: {
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'OutlawOS-Updater',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`GitHub ${res.status}: ${body || res.statusText}`);
    }
    return res;
}

// Fetch the newest release for a channel.
//   'stable' → GitHub's /releases/latest (newest NON-prerelease). This is how
//             the maintainer "blesses" a build: uncheck "pre-release" on the
//             GitHub release and it becomes the stable target.
//   'beta'   → newest release of any kind (includes prereleases). For testers.
async function getLatestRelease(repo, channel = 'stable') {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error('Set the GitHub repository in Settings (format: owner/repo).');

    if (channel === 'beta') {
        const res = await ghFetch(`https://api.github.com/repos/${repo}/releases?per_page=15`);
        const list = await res.json();
        if (!Array.isArray(list) || list.length === 0)
            throw new Error('No releases found for the beta channel.');
        // The API returns releases newest-first; skip drafts but keep prereleases.
        const newest = list.find((r) => !r.draft);
        if (!newest) throw new Error('No published releases found for the beta channel.');
        return newest;
    }

    // stable → GitHub's /releases/latest (newest NON-prerelease).
    try {
        const res = await ghFetch(`https://api.github.com/repos/${repo}/releases/latest`);
        return res.json();
    } catch (e) {
        // No stable release exists yet (every build is still a -Beta pre-release
        // before v1.0). Until then there's NO real difference between channels,
        // so fall back to the newest release so the stable channel still
        // updates. Once a non-prerelease v1.0 ships, /releases/latest succeeds
        // and this fallback never runs again.
        if (!/\b404\b/.test(e.message)) throw e;
        const all = await ghFetch(`https://api.github.com/repos/${repo}/releases?per_page=15`);
        const list = await all.json();
        const newest = Array.isArray(list) ? list.find((r) => !r.draft) : null;
        if (!newest) throw new Error('No releases found yet.');
        return newest;
    }
}

function pickAsset(release, patterns) {
    const assets = release.assets || [];
    for (const p of patterns) {
        const a = assets.find((x) => p.test(x.name));
        if (a) return a;
    }
    return null;
}

// Returns { available, currentVersion, remoteVersion, channel, prerelease, assetUrl, shaUrl, notes, htmlUrl }
async function checkShellUpdate({ repo, currentVersion, channel = 'stable' }) {
    const release = await getLatestRelease(repo, channel);
    const remote = normalize(release.tag_name || release.name || '0');
    const tar = pickAsset(release, [
        /^outlaw-shell-v?[\d.]+\.tar\.gz$/i,
        /^outlaw-shell.*\.tar\.gz$/i,
    ]);
    const sha = pickAsset(release, [
        /^outlaw-shell-v?[\d.]+\.tar\.gz\.sha256$/i,
        /^outlaw-shell.*\.tar\.gz\.sha256$/i,
    ]);
    return {
        currentVersion: normalize(currentVersion),
        remoteVersion: remote,
        channel,
        prerelease: !!release.prerelease,
        available: compareVersions(remote, currentVersion) > 0,
        assetUrl: tar ? tar.browser_download_url : null,
        shaUrl: sha ? sha.browser_download_url : null,
        notes: (release.body || '').slice(0, 4000),
        htmlUrl: release.html_url,
    };
}

async function downloadBinary(url) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'OutlawOS-Updater' } });
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    return Buffer.from(await res.arrayBuffer());
}

function sha256OfFile(file) {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(file));
    return h.digest('hex');
}

// Downloads the asset + checksum, verifies, returns { tarPath, sha }.
async function downloadShellUpdate({ assetUrl, shaUrl }) {
    if (!assetUrl) throw new Error('Release has no shell tarball asset.');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'outlaw-update-'));
    const tarPath = path.join(tmp, 'outlaw-shell.tar.gz');
    fs.writeFileSync(tarPath, await downloadBinary(assetUrl));

    let expected = '';
    if (shaUrl) {
        const shaText = (await downloadBinary(shaUrl)).toString('utf8').trim();
        expected = (shaText.split(/\s+/)[0] || '').toLowerCase();
        const actual = sha256OfFile(tarPath);
        if (expected && expected !== actual) {
            try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
            throw new Error(`Checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…).`);
        }
    } else {
        expected = sha256OfFile(tarPath);
    }
    return { tmp, tarPath, sha: expected };
}

// Advisory community-stability tally for a specific installed version.
// Finds the GitHub release whose tag matches `version` and returns its 👍/👎
// reaction counts (the "works / broken" community signal). No auth needed —
// reaction counts are public. Returns zeros + the releases URL if the release
// or its reactions can't be found, so the UI always has something to show.
async function getStabilityTally({ repo, version }) {
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
        throw new Error('Set the GitHub repository in Settings (format: owner/repo).');
    const res = await ghFetch(`https://api.github.com/repos/${repo}/releases?per_page=30`);
    const list = await res.json();
    const want = normalize(version);
    const rel = (Array.isArray(list) ? list : []).find(
        (r) => normalize(r.tag_name || r.name || '') === want
    );
    const reactions = (rel && rel.reactions) || {};
    return {
        found: !!rel,
        tagName: rel ? (rel.tag_name || '') : '',
        works: reactions['+1'] || 0,
        broken: reactions['-1'] || 0,
        htmlUrl: rel ? rel.html_url : `https://github.com/${repo}/releases`,
    };
}

module.exports = {
    checkShellUpdate,
    downloadShellUpdate,
    getStabilityTally,
    compareVersions,
    normalize,
};

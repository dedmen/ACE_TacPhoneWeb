/**
 * Local HTTPS certificate helper for the live test suites.
 *
 * The debug LAN web host uses Kestrel's ASP.NET Core development certificate.
 * Node does not trust that self-signed certificate unless it is supplied as an
 * extra CA. This module exports the exact certificate the running host presents
 * (or the newest valid `CN=localhost` dev certificate from the Windows store),
 * writes it to a stable PEM file and installs it for the current process and any
 * child processes.
 *
 * The PEM path is printed on every live run so a developer who starts Node
 * manually can set `NODE_EXTRA_CA_CERTS` to the same file.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

const HOST = 'localhost';
const PORT = 8001;

let certificateAuthority = null;
let pemPath = null;

function defaultPemPath() {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'TacPhone', 'localhost-test-ca.pem');
}

function toPem(raw) {
    const base64 = Buffer.from(raw).toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

function writePem(raw) {
    const pem = toPem(raw);
    fs.mkdirSync(path.dirname(pemPath), { recursive: true });
    fs.writeFileSync(pemPath, pem, 'utf8');
    return pem;
}

/** Reads the certificate the running LAN web host actually presents. */
function fetchServedCertificate() {
    return new Promise((resolve, reject) => {
        const socket = tls.connect({
            host: HOST,
            port: PORT,
            servername: HOST,
            rejectUnauthorized: false,
        });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`timed out connecting to ${HOST}:${PORT}`));
        }, 2000);

        socket.once('secureConnect', () => {
            clearTimeout(timer);
            const certificate = socket.getPeerCertificate();
            socket.end();

            if (!certificate || !certificate.raw) {
                reject(new Error('the server returned no peer certificate'));
                return;
            }

            resolve(certificate.raw);
        });

        socket.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

/** Newest valid `CN=localhost` dev certificate from CurrentUser\My. */
function fetchDevCertificateFromStore() {
    if (process.platform !== 'win32') return null;

    const script = [
        "$cert = Get-ChildItem Cert:\\CurrentUser\\My |",
        "  Where-Object { $_.Subject -eq 'CN=localhost' -and $_.NotAfter -gt (Get-Date) } |",
        '  Sort-Object NotAfter -Descending |',
        '  Select-Object -First 1',
        'if ($null -eq $cert) { exit 1 }',
        '[Convert]::ToBase64String($cert.RawData)',
    ].join('\n');

    try {
        const base64 = execFileSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', windowsHide: true },
        ).trim();

        return base64 ? Buffer.from(base64, 'base64') : null;
    } catch {
        return null;
    }
}

function createDevCertificate() {
    try {
        execFileSync('dotnet', ['dev-certs', 'https'], {
            stdio: 'ignore',
            windowsHide: true,
        });
    } catch {
        // No dotnet SDK/runtime; fall through to the clear warning below.
    }
}

function installCertificate(raw) {
    const pem = writePem(raw);
    const authorities = [...tls.rootCertificates, pem];
    certificateAuthority = authorities;

    // Current process: Node has already loaded its root store, so set the CA on
    // the global HTTPS agent as well. Include the default roots so remote relay
    // tests keep validating against the public CA store. Child processes inherit
    // NODE_EXTRA_CA_CERTS.
    process.env.NODE_EXTRA_CA_CERTS = pemPath;
    https.globalAgent.options.ca = authorities;

    return authorities;
}

/**
 * Ensures a PEM file exists and installs it for this process.
 *
 * Safe to call more than once; later calls return the cached PEM.
 * @returns {Promise<string[]|null>} Default roots plus the local PEM, or null when no certificate was found.
 */
export async function ensureLocalCertificate() {
    if (certificateAuthority) return certificateAuthority;
    if (pemPath === null) pemPath = defaultPemPath();

    const configured = process.env.NODE_EXTRA_CA_CERTS;
    if (configured && fs.existsSync(configured)) {
        installConfiguredCertificate(configured);
        console.log(`[TacPhone tests] Using NODE_EXTRA_CA_CERTS: ${configured}`);
        return certificateAuthority;
    }

    let raw = null;
    let source = '';

    try {
        raw = await fetchServedCertificate();
        source = `running host ${HOST}:${PORT}`;
    } catch {
        // The host may not be running yet; fall back to the developer certificate.
    }

    if (!raw) {
        raw = fetchDevCertificateFromStore();
        source = 'Windows dev certificate store';
    }

    if (!raw) {
        createDevCertificate();
        raw = fetchDevCertificateFromStore();
        source = 'Windows dev certificate store (newly created)';
    }

    if (!raw) {
        console.warn(
            '[TacPhone tests] Could not find the local HTTPS certificate. '
            + 'Start the debug LAN web host or set NODE_EXTRA_CA_CERTS to its PEM file.',
        );
        return null;
    }

    const pem = installCertificate(raw);
    console.log(`[TacPhone tests] Local HTTPS certificate: ${pemPath} (${source})`);
    console.log(
        '[TacPhone tests] If you start Node directly, set:\n'
        + `  $env:NODE_EXTRA_CA_CERTS = "${pemPath}"`,
    );

    if (source.includes('newly created')) {
        console.log(
            '[TacPhone tests] Restart Arma before connecting: the debug LAN web host '
            + 'was already running without this certificate.',
        );
    }

    return pem;
}

function installConfiguredCertificate(filePath) {
    const pem = fs.readFileSync(filePath, 'utf8');
    const authorities = [...tls.rootCertificates, pem];
    certificateAuthority = authorities;
    https.globalAgent.options.ca = authorities;
}

/** Default roots plus the local PEM installed by `ensureLocalCertificate`. */
export function getTestCertificateAuthority() {
    return certificateAuthority;
}

/** The PEM file path printed by `ensureLocalCertificate`, if any. */
export function getTestCertificatePath() {
    return pemPath;
}

/**
 * Optional account-provisioning hook. When `DSH_SERVER_LOGIN_PROVISION_SCRIPT`
 * is set, the orchestrator runs it after a user registers so an admin can
 * create the per-user OS account + chown in one shot (hard isolation, P7).
 *
 * The script receives the user id and username as argv (`$1` `$2`); the user's
 * uid can be derived with `dsh-server-login uid-for-user`. A failure is logged
 * but does not fail registration — the user can still log in under soft
 * isolation until the account is provisioned.
 * @module dsh-server-login/provision
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/**
 * Run the configured provision script for a newly registered user.
 * @param script - the script path (absolute), or empty to skip.
 * @param userId - the new user's id.
 * @param username - the new user's username.
 * @returns a short status line for the audit log.
 */
export async function runProvisionScript(script, userId, username) {
    if (script === '')
        return 'skipped';
    try {
        await execFileAsync(script, [userId, username], { timeout: 15000 });
        return `ok: ${script}`;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `failed: ${message}`;
    }
}
//# sourceMappingURL=provision.js.map
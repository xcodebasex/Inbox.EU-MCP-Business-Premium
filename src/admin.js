import { InboxEuError } from './client.js';
import { operations } from './operations.js';

const globalAdmin = operations.find(operation => operation.name === 'inboxeu_get_admin');
const domainAdminLookup = operations.find(operation => operation.name === 'inboxeu_get_domain_admin');
const currentProfile = operations.find(operation => operation.name === 'inboxeu_get_profile');

export async function readAdmin(request, { domainAdmin, domainName }, signal) {
  try {
    return await request({ ...globalAdmin.build({ domainAdmin }), method: 'GET', signal });
  } catch (error) {
    if (!(error instanceof InboxEuError) || ![401, 403].includes(error.httpStatus)) throw error;
    const fallback = domainName ? domainAdminLookup : currentProfile;
    const params = fallback.build({ domainName, domainAdmin });
    const response = await request({ ...params, method: 'GET', signal });
    const id = response.data.data?.id;
    // A successful profile read only answers this lookup when it identifies the requested administrator.
    if (id !== domainAdmin && !(Number.isSafeInteger(id) && String(id) === domainAdmin)) {
      throw error;
    }
    return { ...response, source: domainName ? 'domain_admin' : 'current_profile' };
  }
}

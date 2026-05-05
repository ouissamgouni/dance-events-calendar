const STORAGE_KEY = 'movida_device_id';

export function getDeviceId(): string {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
}

/**
 * Replace the current device id with a fresh UUID. Called on logout so
 * the next anonymous activity on this device cannot be claimed by whoever
 * signs in next (e.g. a different user on the same browser).
 */
export function rotateDeviceId(): string {
    const id = crypto.randomUUID();
    localStorage.setItem(STORAGE_KEY, id);
    return id;
}

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const pattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const compareMutationId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function ulid(now = Date.now(), floor: string | null = null): string {
    if (!Number.isSafeInteger(now) || now < 0 || (floor !== null && !pattern.test(floor))) throw new Error('Invalid mutation clock or watermark');
    let time = now;
    if (floor) {
        let floorTime = 0;
        for (const char of floor.slice(0, 10)) floorTime = floorTime * 32 + alphabet.indexOf(char);
        if (floorTime >= time) time = floorTime + 1;
    }
    if (time > 0xffffffffffff) throw new Error('Mutation clock exhausted');
    let prefix = '';
    for (let i = 0; i < 10; i++) { prefix = alphabet[time % 32] + prefix; time = Math.floor(time / 32); }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return prefix + Array.from(bytes, byte => alphabet[byte & 31]).join('');
}

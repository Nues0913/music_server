/** Expected source validation failures; filesystem/DB failures retain their original types. */
export class InvalidAudioError extends Error {}
export class CapacityError extends Error {}
export class NormalizedAudioTooLargeError extends Error {}

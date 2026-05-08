/**
 * Jest unit test: backend/files.js sniffMimeFromExtension()
 *
 * Regression coverage for PR #2521: curl/multer often report
 * application/octet-stream for .mp4 uploads, which causes
 * chat.html's mimeType.startsWith('video/') branch to skip the
 * inline player. sniffMimeFromExtension() rescues those uploads
 * by reading the filename extension when the supplied mime is
 * generic.
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({})),
    PutObjectCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
    DeleteObjectCommand: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/x'),
}));

const { sniffMimeFromExtension } = require('../../files');

describe('sniffMimeFromExtension', () => {
    test('returns supplied mime when specific (passes through)', () => {
        expect(sniffMimeFromExtension('clip.mp4', 'video/mp4')).toBe('video/mp4');
        expect(sniffMimeFromExtension('photo.jpg', 'image/jpeg')).toBe('image/jpeg');
        expect(sniffMimeFromExtension('doc.pdf', 'application/pdf')).toBe('application/pdf');
    });

    test('rescues video uploads when supplied mime is application/octet-stream', () => {
        expect(sniffMimeFromExtension('eclaw-promo.mp4', 'application/octet-stream')).toBe('video/mp4');
        expect(sniffMimeFromExtension('intro.webm', 'application/octet-stream')).toBe('video/webm');
        expect(sniffMimeFromExtension('clip.mov', 'application/octet-stream')).toBe('video/quicktime');
        expect(sniffMimeFromExtension('reel.m4v', 'application/octet-stream')).toBe('video/mp4');
    });

    test('rescues audio uploads when supplied mime is generic', () => {
        expect(sniffMimeFromExtension('bgm.mp3', 'application/octet-stream')).toBe('audio/mpeg');
        expect(sniffMimeFromExtension('voice.m4a', 'application/octet-stream')).toBe('audio/mp4');
        expect(sniffMimeFromExtension('track.wav', '')).toBe('audio/wav');
        expect(sniffMimeFromExtension('audio.opus', null)).toBe('audio/opus');
    });

    test('rescues image uploads when supplied mime is missing', () => {
        expect(sniffMimeFromExtension('shot.png', '')).toBe('image/png');
        expect(sniffMimeFromExtension('shot.JPG', undefined)).toBe('image/jpeg');
        expect(sniffMimeFromExtension('icon.webp', 'application/octet-stream')).toBe('image/webp');
    });

    test('also rescues application/binary fallback', () => {
        expect(sniffMimeFromExtension('clip.mp4', 'application/binary')).toBe('video/mp4');
    });

    test('case-insensitive extension matching', () => {
        expect(sniffMimeFromExtension('CLIP.MP4', 'application/octet-stream')).toBe('video/mp4');
        expect(sniffMimeFromExtension('Photo.PNG', '')).toBe('image/png');
    });

    test('handles paths with directories and backslashes', () => {
        expect(sniffMimeFromExtension('/var/uploads/clip.mp4', 'application/octet-stream')).toBe('video/mp4');
        expect(sniffMimeFromExtension('C:\\Users\\me\\bgm.mp3', 'application/octet-stream')).toBe('audio/mpeg');
    });

    test('falls back to octet-stream for unknown extensions', () => {
        expect(sniffMimeFromExtension('archive.xyz', 'application/octet-stream')).toBe('application/octet-stream');
        expect(sniffMimeFromExtension('noext', '')).toBe('application/octet-stream');
    });

    test('does not override non-generic supplied mime', () => {
        // If the client claimed a specific (non-octet-stream) type, trust it.
        expect(sniffMimeFromExtension('clip.mp4', 'video/webm')).toBe('video/webm');
        expect(sniffMimeFromExtension('clip.mp4', 'application/x-custom')).toBe('application/x-custom');
    });
});

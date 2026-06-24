const sharp = require('sharp');

const {
    saveFeedbackPhoto,
    stripFeedbackPhotoMetadata
} = require('../../device-feedback');

async function makeJpegWithExif() {
    return sharp({
        create: {
            width: 8,
            height: 8,
            channels: 3,
            background: { r: 220, g: 30, b: 30 }
        }
    })
        .jpeg()
        .withMetadata({
            exif: {
                IFD0: { Artist: 'EClaw feedback test' },
                GPS: {
                    GPSLatitudeRef: 'N',
                    GPSLatitude: '25/1 2/1 3/1',
                    GPSLongitudeRef: 'E',
                    GPSLongitude: '121/1 33/1 4/1'
                }
            }
        })
        .toBuffer();
}

describe('feedback photo sanitization', () => {
    it('strips EXIF metadata before returning a photo buffer', async () => {
        const original = await makeJpegWithExif();
        const originalMetadata = await sharp(original).metadata();
        expect(originalMetadata.format).toBe('jpeg');
        expect(originalMetadata.exif).toBeDefined();

        const sanitized = await stripFeedbackPhotoMetadata(original, 'image/jpeg');

        expect(sanitized.error).toBeUndefined();
        const metadata = await sharp(sanitized.buffer).metadata();
        expect(metadata.format).toBe('jpeg');
        expect(metadata.exif).toBeUndefined();
    });

    it('stores the sanitized buffer instead of the uploaded original', async () => {
        const original = await makeJpegWithExif();
        const pool = {
            query: jest.fn()
                .mockResolvedValueOnce({ rows: [{ count: '0' }] })
                .mockResolvedValueOnce({
                    rows: [{ id: 7, feedback_id: 42, file_name: 'photo.jpg', created_at: 1234 }]
                })
        };

        const result = await saveFeedbackPhoto(pool, 42, original, 'image/jpeg', 'photo.jpg');

        expect(result).toMatchObject({ id: 7, feedback_id: 42, file_name: 'photo.jpg' });
        expect(pool.query).toHaveBeenCalledTimes(2);

        const insertParams = pool.query.mock.calls[1][1];
        const storedBuffer = insertParams[1];
        const storedContentType = insertParams[2];
        const storedMetadata = await sharp(storedBuffer).metadata();

        expect(storedContentType).toBe('image/jpeg');
        expect(storedBuffer.equals(original)).toBe(false);
        expect(storedMetadata.exif).toBeUndefined();
    });
});

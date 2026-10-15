require('./helpers/mock-setup');
const { DRIVERS } = require('../e2e/matrix/drivers');

describe('matrix redirect uses its maintained public test profile', () => {
    const prior = { redirect: process.env.MATRIX_REDIRECT_CODE, entity: process.env.MATRIX_TEST_ENTITY_PUBLIC_CODE };
    afterEach(() => {
        for (const [name, value] of [['MATRIX_REDIRECT_CODE', prior.redirect], ['MATRIX_TEST_ENTITY_PUBLIC_CODE', prior.entity]]) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
    });
    const page = (code, status = 200) => ({ goto: jest.fn().mockResolvedValue({ status: () => status }), url: () => 'https://fixture.invalid/p/' + code });
    test('configured test entity is used instead of a removed personal profile', async () => {
        delete process.env.MATRIX_REDIRECT_CODE;
        process.env.MATRIX_TEST_ENTITY_PUBLIC_CODE = 'abc123';
        const browser = page('abc123');
        expect((await DRIVERS.redirect(browser, { base: 'https://fixture.invalid' })).ok).toBe(true);
        expect(browser.goto.mock.calls[0][0]).toBe('https://fixture.invalid/r/profile?publicCode=abc123');
    });
    test('explicit redirect override retains precedence', async () => {
        process.env.MATRIX_REDIRECT_CODE = 'def456';
        process.env.MATRIX_TEST_ENTITY_PUBLIC_CODE = 'abc123';
        expect((await DRIVERS.redirect(page('def456'), { base: 'https://fixture.invalid' })).ok).toBe(true);
    });
    test('an unavailable profile still fails the matrix cell', async () => {
        delete process.env.MATRIX_REDIRECT_CODE;
        process.env.MATRIX_TEST_ENTITY_PUBLIC_CODE = 'abc123';
        expect((await DRIVERS.redirect(page('abc123', 404), { base: 'https://fixture.invalid' })).ok).toBe(false);
    });
});

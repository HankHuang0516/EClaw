const AvatarPetdx = require('../../public/shared/avatar-petdx.js');

describe('AvatarPetdx.descriptorAvatarUrl', () => {
    it('returns the API companion avatarUrl when present', () => {
        AvatarPetdx._setDescriptor(801, {
            id: 'petdx-lobster-default',
            avatarUrl: '/static/companions/petdx-lobster-default/avatar.png',
        });

        expect(AvatarPetdx.descriptorAvatarUrl(801))
            .toBe('/static/companions/petdx-lobster-default/avatar.png');
    });

    it('returns descriptor.avatar.url when cached descriptor carries the parent spec shape', () => {
        AvatarPetdx._setDescriptor(802, {
            descriptor: {
                avatar: { url: '/static/companions/custom/avatar.png' },
            },
        });

        expect(AvatarPetdx.descriptorAvatarUrl(802))
            .toBe('/static/companions/custom/avatar.png');
    });

    it('returns null when no cached descriptor has an avatar URL', () => {
        AvatarPetdx._setDescriptor(803, { id: 'no-avatar' });

        expect(AvatarPetdx.descriptorAvatarUrl(803)).toBeNull();
        expect(AvatarPetdx.descriptorAvatarUrl(804)).toBeNull();
    });
});

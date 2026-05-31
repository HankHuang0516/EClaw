const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../../public/portal/kanban.html'), 'utf8');

function slice(anchor, span = 1200) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('kanban entity avatars match dashboard resolver chain', () => {
    test('loads entities into the shared avatar maps before rendering cards', () => {
        const initBlock = slice('// Load entities for assignee picker', 1400);
        expect(initBlock).toContain('updateEntityMaps(boundEntities)');
        expect(initBlock).toContain('AvatarPetdx.preload');
        expect(initBlock.indexOf('updateEntityMaps(boundEntities)'))
            .toBeLessThan(initBlock.indexOf('AvatarPetdx.preload'));
    });

    test('all kanban avatar surfaces use getAvatarForEntity + renderAvatarHtml', () => {
        const helperBlock = slice('function renderKanbanEntityAvatar', 900);
        expect(helperBlock).toContain('getAvatarForEntity(eid)');
        expect(helperBlock).toContain('renderAvatarHtml(avatar');

        expect(src).toContain("renderKanbanEntityAvatar(id, 16, 'kb-card-avatar-face')");
        expect(src).toContain("renderKanbanEntityAvatar(e.entityId, 16, 'kb-assign-avatar')");
        expect(src).toContain("renderKanbanEntityAvatar(fromId, 16, 'comment-avatar')");
        expect(src).toContain("renderKanbanEntityAvatar(eid, 24, 'kb-tl-lane-avatar')");
    });

    test('assignee chips do not bypass the shared resolver with raw e.avatar', () => {
        expect(src).not.toMatch(/renderAvatarHtml\(e\.avatar/);
        expect(src).not.toMatch(/const\s+avatarEl\s*=[^;]*e\.avatar/);
    });
});

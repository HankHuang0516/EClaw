package com.hank.clawlive

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CompanionCacheInvalidationStaticTest {
    @Test
    fun companionRepositoryClearsCachedDescriptorWhenCurrentSelectionIsNull() {
        val repo = readSource("com/hank/clawlive/data/repository/CompanionRepository.kt")

        assertTrue(repo.contains("fun clearCompanion(entityId: Int)"))
        assertTrue(repo.contains("descriptorCache.remove(entityId)"))
        assertTrue(repo.contains("snapshotCache.removeCompanion(entityId)"))
        assertTrue(repo.contains("resp.selection?.companion"))
        assertTrue(repo.contains("Companion cleared for entity \$entityId: no current selection"))
        assertTrue(!repo.contains("keeping previous companion"))
    }

    @Test
    fun wallpaperAndPreviewPruneCompanionCacheToActiveBoundEntities() {
        val wallpaper = readSource("com/hank/clawlive/service/ClawWallpaperService.kt")
        val preview = readSource("com/hank/clawlive/WallpaperPreviewActivity.kt")

        assertTrue(wallpaper.contains("companionRepository.pruneTo(activeIds)"))
        assertTrue(wallpaper.contains("companionRepository.clearCompanion(id)"))
        assertTrue(preview.contains("companionRepository.pruneTo(activeIds)"))
        assertTrue(preview.contains("companionRepository.clearCompanion(entityId)"))
    }

    @Test
    fun durableSnapshotCacheCanRemoveAndPruneCompanionDescriptors() {
        val cache = readSource("com/hank/clawlive/data/local/WallpaperEntitySnapshotCache.kt")

        assertTrue(cache.contains("fun removeCompanion(entityId: Int)"))
        assertTrue(cache.contains("companions.remove(entityId)"))
        assertTrue(cache.contains("fun pruneCompanionsTo(activeEntityIds: Set<Int>)"))
        assertTrue(cache.contains("companions.keys.retainAll(activeEntityIds)"))
    }

    private fun readSource(relPath: String): String {
        val candidates = listOf(
            File("src/main/java/$relPath"),
            File("app/src/main/java/$relPath")
        )
        val file = candidates.firstOrNull { it.isFile }
            ?: error("Could not locate $relPath from ${File(".").absolutePath}")
        return file.readText()
    }
}

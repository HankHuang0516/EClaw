package com.hank.clawlive

import com.hank.clawlive.data.repository.resolveCompanionAssetUrl
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CompanionAssetUrlTest {
    @Test
    fun resolvesRelativePetdxApiSpritesheetPathAgainstProductionBase() {
        assertEquals(
            "https://eclawbot.com/api/petdx/community/xiaoyu-e23e75f0ae6a/sprite.webp",
            resolveCompanionAssetUrl("/api/petdx/community/xiaoyu-e23e75f0ae6a/sprite.webp")
        )
    }

    @Test
    fun keepsAbsoluteSpritesheetUrlsUnchanged() {
        assertEquals(
            "https://cdn.example.com/pets/sheet.webp",
            resolveCompanionAssetUrl("https://cdn.example.com/pets/sheet.webp")
        )
        assertEquals(
            "http://cdn.example.com/pets/sheet.webp",
            resolveCompanionAssetUrl("http://cdn.example.com/pets/sheet.webp")
        )
    }

    @Test
    fun resolvesProtocolRelativeAndBarePaths() {
        assertEquals(
            "https://cdn.example.com/pets/sheet.webp",
            resolveCompanionAssetUrl("//cdn.example.com/pets/sheet.webp")
        )
        assertEquals(
            "https://eclawbot.com/api/petdx/sheet.webp",
            resolveCompanionAssetUrl("api/petdx/sheet.webp")
        )
    }

    @Test
    fun blankSpritesheetUrlReturnsNull() {
        assertNull(resolveCompanionAssetUrl(null))
        assertNull(resolveCompanionAssetUrl("   "))
    }
}

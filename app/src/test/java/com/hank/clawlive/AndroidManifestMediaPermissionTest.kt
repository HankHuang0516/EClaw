package com.hank.clawlive

import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class AndroidManifestMediaPermissionTest {

    @Test
    fun manifestDoesNotRequestBroadPhotoOrVideoLibraryAccess() {
        val declaredPermissions = readManifestPermissions()
        val disallowedPermissions = setOf(
            "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO",
            "android.permission.READ_EXTERNAL_STORAGE",
            "android.permission.WRITE_EXTERNAL_STORAGE"
        )

        val declaredDisallowedPermissions = declaredPermissions.intersect(disallowedPermissions)
        assertTrue(
            "Use Android picker URI grants instead of broad media/storage permissions: $declaredDisallowedPermissions",
            declaredDisallowedPermissions.isEmpty()
        )
    }

    private fun readManifestPermissions(): Set<String> {
        val manifest = locateManifest()
        val documentBuilderFactory = DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = true
        }
        val document = documentBuilderFactory.newDocumentBuilder().parse(manifest)
        val nodes = document.getElementsByTagName("uses-permission")

        return (0 until nodes.length)
            .mapNotNull { index ->
                val element = nodes.item(index) as? Element ?: return@mapNotNull null
                element.getAttributeNS(ANDROID_NAMESPACE, "name")
                    .takeIf { it.isNotBlank() }
                    ?: element.getAttribute("android:name").takeIf { it.isNotBlank() }
            }
            .toSet()
    }

    private fun locateManifest(): File {
        val candidates = listOf(
            File("src/main/AndroidManifest.xml"),
            File("app/src/main/AndroidManifest.xml")
        )

        return candidates.firstOrNull { it.isFile }
            ?: error("Could not locate AndroidManifest.xml from ${File(".").absolutePath}")
    }

    private companion object {
        private const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
    }
}

package com.hank.clawlive.util

import android.content.Context
import android.net.Uri
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import java.util.Locale

object LocaleHelper {
    private val SUPPORTED = setOf(
        "en", "zh", "zh-CN", "ja", "ko", "th", "vi", "id",
        "fr", "es", "de", "ms", "hi", "ar"
    )

    fun toPortalLang(locale: Locale?): String {
        if (locale == null) return "en"
        val lang = locale.language.lowercase()
        val country = locale.country.uppercase()
        val script = locale.script
        if (lang == "zh") {
            val simplified = script == "Hans" || country == "CN" || country == "SG"
            return if (simplified) "zh-CN" else "zh"
        }
        val normalized = if (lang == "in") "id" else lang
        return if (normalized in SUPPORTED) normalized else "en"
    }

    @Suppress("UNUSED_PARAMETER")
    fun currentPortalLang(context: Context): String {
        val locales = AppCompatDelegate.getApplicationLocales()
        val locale = if (!locales.isEmpty) locales.get(0)
        else LocaleListCompat.getDefault().get(0)
        return toPortalLang(locale)
    }
}

object PortalUrlHelper {
    fun withAppLang(context: Context, url: String): String =
        withLang(url, LocaleHelper.currentPortalLang(context))

    fun withLang(url: String, lang: String): String {
        val uri = Uri.parse(url)
        val builder = uri.buildUpon().clearQuery()
        uri.queryParameterNames.forEach { name ->
            if (name != "lang") {
                uri.getQueryParameters(name).forEach { value ->
                    builder.appendQueryParameter(name, value)
                }
            }
        }
        builder.appendQueryParameter("lang", lang)
        return builder.build().toString()
    }
}

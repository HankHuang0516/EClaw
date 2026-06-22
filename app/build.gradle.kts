import java.util.Properties
import java.io.FileInputStream

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.kotlinAndroid)
    id("kotlin-kapt")
    alias(libs.plugins.googleServices)
}

android {
    namespace = "com.hank.clawlive"
    compileSdk = 35

    buildFeatures {
        buildConfig = true
    }

    defaultConfig {
        applicationId = "com.hank.clawlive"
        minSdk = 24
        targetSdk = 35
        versionCode = 110
        versionName = "1.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    val keystorePropertiesFile = rootProject.file("keystore.properties")
    val keystoreProperties = Properties()
    if (keystorePropertiesFile.exists()) {
        keystoreProperties.load(FileInputStream(keystorePropertiesFile))
    }
    val hasReleaseSigning = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
        .all { key -> (keystoreProperties[key] as? String)?.isNotBlank() == true }

    signingConfigs {
        create("release") {
            if (hasReleaseSigning) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // CI/fork builds do not have the upload keystore. Use debug signing
            // there so release compilation is still testable; Play upload must
            // run on a machine with keystore.properties.
            signingConfig = signingConfigs.getByName(if (hasReleaseSigning) "release" else "debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }

    lint {
        // Treat MissingTranslation as warning instead of error
        // so CI doesn't fail on untranslated strings
        disable += "MissingTranslation"
        abortOnError = false
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.material)

    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.coroutines.core)

    implementation(libs.timber)

    implementation(libs.retrofit)
    implementation(libs.retrofit.converter.gson)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)

    // Google Play Billing for subscriptions
    implementation(libs.billing)
    implementation(libs.play.integrity)

    // Google Play Core In-App Update (Settings update-available chip — card_28a8290a)
    implementation(libs.play.app.update)
    implementation(libs.play.app.update.ktx)

    // Room Database for chat history
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    kapt(libs.room.compiler)

    // Markwon for Markdown rendering in Mission Control
    implementation(libs.markwon.core)

    // Glide for image loading (chat photos)
    implementation(libs.glide)
    kapt(libs.glide.compiler)

    // Socket.IO for real-time notifications
    implementation(libs.socket.io.client)

    // Firebase Cloud Messaging (FCM) for push notifications
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    // Google Sign-In (Credential Manager)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services)
    implementation(libs.google.id)

    // Facebook Login
    implementation(libs.facebook.login)
    implementation(libs.play.services.location)

    // Unit test dependencies
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.code.gson:gson:2.10.1")

    // AndroidTest dependencies
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:core:1.5.0")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("androidx.test:rules:1.5.0")
}

configurations.all {
    resolutionStrategy {
        force("org.jetbrains.kotlinx:kotlinx-metadata-jvm:2.0.0")
    }
}

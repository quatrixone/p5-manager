plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.p5manager.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.p5manager.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The native Remote Play client is built for 64-bit phones only;
        // every console-era device is one.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    // The repository's own key, handed in by CI through the environment.
    // Without it the release APK carries the debug signature: enough to
    // install by hand, not enough to update a differently signed copy.
    val storeFile = System.getenv("P5M_STORE_FILE")
    signingConfigs {
        if (!storeFile.isNullOrBlank()) {
            create("release") {
                this.storeFile = file(storeFile)
                storePassword = System.getenv("P5M_STORE_PASSWORD")
                keyAlias = System.getenv("P5M_KEY_ALIAS")
                keyPassword = System.getenv("P5M_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { viewBinding = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.2.0")
    // QR scanning for the server address the web UI shows.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("junit:junit:4.13.2")
}

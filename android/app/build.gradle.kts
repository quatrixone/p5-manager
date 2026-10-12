plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.p5manager.app"
    compileSdk = 35
    // Pinned so the native session is built against the same toolchain in
    // CI and on a workstation.
    ndkVersion = "27.1.12297006"

    defaultConfig {
        applicationId = "com.p5manager.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The native Remote Play client is built for 64-bit phones only;
        // every console-era device is one.
        ndk { abiFilters += listOf("arm64-v8a") }
        externalNativeBuild {
            cmake {
                // chiaki-lib and its dependencies are C; nothing here needs
                // the C++ standard library beyond what the NDK links by
                // default.
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    // OpenSSL comes from the NDK's own prefab package.
    buildFeatures { prefab = true }

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
    // OpenSSL for the native Remote Play session, as a prefab AAR.
    implementation("com.android.ndk.thirdparty:openssl:1.1.1q-beta-1")
    testImplementation("junit:junit:4.13.2")
}

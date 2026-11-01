import java.io.File
import java.net.InetSocketAddress
import java.net.Socket
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject
import org.gradle.process.ExecOperations

abstract class BuildTask : DefaultTask() {
    @get:Inject
    abstract val execOperations: ExecOperations

    @Input
    var rootDirRel: String? = null
    @Input
    var projectDir: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """npm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    /**
     * WSL (virtioproxy networking): loopback connections to some listeners are refused, among them
     * the Tauri CLI's options server that `android-studio-script` reads its settings from. The CLI
     * itself already compiled the Rust library and linked it into jniLibs before it started Gradle,
     * so when the server cannot be reached and that library exists, this task has nothing to do.
     * Returns true when the server answered (or no server file exists: the script reports that).
     */
    fun waitForTauriCli(): Boolean {
        val serverFile = File(File(projectDir).parentFile, ".tauri/cli-options-server.json")
        if (!serverFile.exists()) return true
        val addr = Regex("""\"addr\"\s*:\s*\"([^\"]+):(\d+)\"""").find(serverFile.readText()) ?: return true
        val (host, port) = addr.destructured
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            try {
                Socket().use { it.connect(InetSocketAddress(host, port.toInt()), 1_000) }
                return true
            } catch (e: java.io.IOException) {
                Thread.sleep(500)
            }
        }
        logger.warn("Tauri CLI options server at $host:$port is not reachable")
        return false
    }

    /** The library the Tauri CLI links into jniLibs for this target before it runs Gradle. */
    fun prebuiltLibrary(): File? {
        val abi = when (target) {
            "aarch64" -> "arm64-v8a"
            "armv7" -> "armeabi-v7a"
            "i686" -> "x86"
            "x86_64" -> "x86_64"
            else -> return null
        }
        val dir = File(projectDir, "src/main/jniLibs/$abi")
        return dir.listFiles { f -> f.name.endsWith(".so") }?.firstOrNull()
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");
        if (!waitForTauriCli()) {
            val lib = prebuiltLibrary()
            if (lib != null) {
                logger.warn("Using the library the Tauri CLI already built: $lib")
                return
            }
        }

        execOperations.exec {
            workingDir(File(projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
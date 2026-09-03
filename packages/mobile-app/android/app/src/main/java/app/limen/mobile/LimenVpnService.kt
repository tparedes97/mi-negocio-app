package app.limen.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress

/**
 * VPN local que bloquea dominios a nivel DNS — el reemplazo de
 * chrome.declarativeNetRequest para Android (esa API no existe fuera de
 * extensiones de navegador). Solo intercepta tráfico DNS: la ruta que le
 * pasamos al VpnService.Builder es específica a nuestra "IP" de DNS falsa,
 * no 0.0.0.0/0, así que el resto del tráfico (HTTP/HTTPS normal) sigue su
 * camino sin pasar por acá. Ver DnsPacketUtil.kt para el parseo/armado de
 * paquetes.
 *
 * No probado en un dispositivo/emulador real (no hay Android SDK en el
 * entorno donde se escribió) — revisar con cuidado antes de confiar en
 * esto en producción.
 */
class LimenVpnService : VpnService() {

    companion object {
        private const val TAG = "LimenVpnService"
        private const val VPN_ADDRESS = "10.111.222.1"
        private const val FAKE_DNS_ADDRESS = "10.111.222.2"
        private const val UPSTREAM_DNS = "8.8.8.8"
        private const val NOTIF_CHANNEL_ID = "limen_vpn_channel"
        private const val NOTIF_ID = 42071

        const val ACTION_START = "app.limen.mobile.action.START_VPN"
        const val ACTION_STOP = "app.limen.mobile.action.STOP_VPN"
        const val EXTRA_DOMAINS = "domains"

        @Volatile var isRunning: Boolean = false
            private set

        /** El plugin de Capacitor se suscribe acá para enterarse de intentos bloqueados. */
        var blockedAttemptListener: ((domain: String) -> Unit)? = null
    }

    private var vpnInterface: ParcelFileDescriptor? = null
    private var workerThread: Thread? = null
    @Volatile private var running = false
    private var blockedDomains: Set<String> = emptySet()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopVpn()
                return START_NOT_STICKY
            }
            else -> {
                val domains = intent?.getStringArrayListExtra(EXTRA_DOMAINS)?.toSet() ?: emptySet()
                startVpn(domains)
                return START_STICKY
            }
        }
    }

    private fun startVpn(domains: Set<String>) {
        persistState(active = true, domains = domains)

        if (running) {
            blockedDomains = domains
            return
        }
        blockedDomains = domains

        val builder = Builder()
            .setSession("Limen")
            .addAddress(VPN_ADDRESS, 32)
            .addDnsServer(FAKE_DNS_ADDRESS)
            // Solo capturamos tráfico hacia nuestra "IP" de DNS falsa —
            // el resto de internet (HTTP/HTTPS real) no pasa por el túnel.
            .addRoute(FAKE_DNS_ADDRESS, 32)
            .setBlocking(true)

        vpnInterface = builder.establish()
        if (vpnInterface == null) {
            Log.e(TAG, "No se pudo establecer la interfaz VPN (¿falta el permiso del usuario?)")
            return
        }

        startForeground(NOTIF_ID, buildNotification())
        running = true
        isRunning = true

        workerThread = Thread { runPacketLoop() }.apply {
            name = "LimenVpnWorker"
            start()
        }
    }

    private fun stopVpn() {
        persistState(active = false, domains = emptySet())
        running = false
        isRunning = false
        workerThread?.interrupt()
        workerThread = null
        try { vpnInterface?.close() } catch (e: IOException) { /* no-op */ }
        vpnInterface = null
        stopForeground(true)
        stopSelf()
    }

    private fun runPacketLoop() {
        val pfd = vpnInterface ?: return
        val input = FileInputStream(pfd.fileDescriptor)
        val output = FileOutputStream(pfd.fileDescriptor)
        val buffer = ByteArray(32767)

        while (running) {
            try {
                val length = input.read(buffer)
                if (length <= 0) continue

                val query = DnsPacketUtil.parseDnsQuery(buffer, length) ?: continue
                val domain = query.domain.lowercase()

                if (isBlocked(domain)) {
                    Log.i(TAG, "Bloqueado: $domain")
                    output.write(DnsPacketUtil.buildBlockedResponse(query))
                    blockedAttemptListener?.invoke(domain)
                } else {
                    forwardToUpstreamDns(query, output)
                }
            } catch (e: IOException) {
                if (running) Log.e(TAG, "Error en el loop de paquetes", e)
            } catch (e: InterruptedException) {
                break
            }
        }
    }

    /**
     * Persistencia mínima propia (no depende de @capacitor/preferences) para
     * que BootReceiver pueda reactivar el bloqueo después de un reinicio del
     * teléfono sin depender de que la webview/JS haya arrancado todavía.
     */
    private fun persistState(active: Boolean, domains: Set<String>) {
        val prefs = getSharedPreferences("limen_vpn_state", MODE_PRIVATE)
        prefs.edit()
            .putBoolean("active", active)
            .putStringSet("domains", domains)
            .apply()
    }

    private fun isBlocked(domain: String): Boolean {
        return blockedDomains.any { blocked -> domain == blocked || domain.endsWith(".$blocked") }
    }

    private fun forwardToUpstreamDns(query: DnsPacketUtil.ParsedDnsQuery, output: FileOutputStream) {
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket()
            protect(socket) // clave: evita que esta consulta vuelva a entrar al túnel

            val dnsMessage = buildRawDnsQuery(query)
            val outPacket = DatagramPacket(
                dnsMessage, dnsMessage.size,
                InetSocketAddress(UPSTREAM_DNS, DnsPacketUtil.DNS_PORT),
            )
            socket.soTimeout = 5000
            socket.send(outPacket)

            val responseBuffer = ByteArray(512)
            val inPacket = DatagramPacket(responseBuffer, responseBuffer.size)
            socket.receive(inPacket)

            val responseBytes = responseBuffer.copyOfRange(0, inPacket.length)
            output.write(DnsPacketUtil.buildForwardedResponse(query, responseBytes))
        } catch (e: IOException) {
            Log.w(TAG, "No se pudo resolver ${query.domain} contra el DNS upstream", e)
        } finally {
            socket?.close()
        }
    }

    /** Reconstruye el mensaje DNS crudo (header + question) para reenviarlo tal cual al DNS real. */
    private fun buildRawDnsQuery(query: DnsPacketUtil.ParsedDnsQuery): ByteArray {
        val header = byteArrayOf(
            query.transactionId[0], query.transactionId[1],
            0x01, 0x00, // flags: consulta estándar, recursión deseada
            0x00, 0x01, // QDCOUNT = 1
            0x00, 0x00, // ANCOUNT
            0x00, 0x00, // NSCOUNT
            0x00, 0x00, // ARCOUNT
        )
        return header + query.questionSection
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIF_CHANNEL_ID, "Bloqueo activo", NotificationManager.IMPORTANCE_LOW,
            )
            nm.createNotificationChannel(channel)
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        return Notification.Builder(this, NOTIF_CHANNEL_ID)
            .setContentTitle("Limen — bloqueo activo")
            .setContentText("Protegiendo tu tiempo. Tocá para abrir la app.")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopVpn()
        super.onDestroy()
    }

    override fun onRevoke() {
        // El usuario desactivó el permiso de VPN desde los ajustes del sistema.
        stopVpn()
        super.onRevoke()
    }
}

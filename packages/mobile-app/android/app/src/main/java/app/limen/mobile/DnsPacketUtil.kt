package app.limen.mobile

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Parseo y armado a mano de paquetes IPv4 + UDP + DNS — no hay librería
 * estándar de Android para esto, es el mismo nivel de trabajo que hacen
 * bloqueadores DNS de código abierto (DNS66, PersonalDNSFilter, etc.).
 *
 * IMPORTANTE: este código no se pudo compilar ni probar en un emulador
 * real desde este entorno (no hay Android SDK acá) — está escrito con
 * cuidado a partir del formato de los protocolos, pero antes de confiar
 * en él en producción hay que probarlo en un dispositivo/emulador real.
 */
object DnsPacketUtil {
    private const val IPV4_HEADER_LEN = 20
    private const val UDP_HEADER_LEN = 8
    const val DNS_PORT = 53

    data class ParsedDnsQuery(
        val sourceAddr: ByteArray,
        val sourcePort: Int,
        val destAddr: ByteArray,
        val destPort: Int,
        val transactionId: ByteArray, // 2 bytes
        val questionSection: ByteArray, // QNAME + QTYPE + QCLASS, tal cual vino
        val domain: String,
    )

    /** Devuelve null si el paquete no es una consulta DNS UDP IPv4 válida. */
    fun parseDnsQuery(packet: ByteArray, length: Int): ParsedDnsQuery? {
        if (length < IPV4_HEADER_LEN + UDP_HEADER_LEN + 12) return null

        val versionAndIhl = packet[0].toInt() and 0xFF
        val version = versionAndIhl shr 4
        if (version != 4) return null // solo IPv4 por ahora
        val ihl = (versionAndIhl and 0x0F) * 4
        if (ihl < IPV4_HEADER_LEN) return null

        val protocol = packet[9].toInt() and 0xFF
        if (protocol != 17) return null // solo UDP

        val sourceAddr = packet.copyOfRange(12, 16)
        val destAddr = packet.copyOfRange(16, 20)

        val udpStart = ihl
        val sourcePort = ((packet[udpStart].toInt() and 0xFF) shl 8) or (packet[udpStart + 1].toInt() and 0xFF)
        val destPort = ((packet[udpStart + 2].toInt() and 0xFF) shl 8) or (packet[udpStart + 3].toInt() and 0xFF)
        if (destPort != DNS_PORT) return null

        val dnsStart = udpStart + UDP_HEADER_LEN
        if (dnsStart + 12 > length) return null

        val qdCount = ((packet[dnsStart + 4].toInt() and 0xFF) shl 8) or (packet[dnsStart + 5].toInt() and 0xFF)
        if (qdCount < 1) return null

        val transactionId = packet.copyOfRange(dnsStart, dnsStart + 2)

        // Parsear QNAME (labels con largo-prefijo, termina en 0x00)
        var pos = dnsStart + 12
        val labels = mutableListOf<String>()
        while (pos < length) {
            val labelLen = packet[pos].toInt() and 0xFF
            if (labelLen == 0) { pos += 1; break }
            if (pos + 1 + labelLen > length) return null
            labels.add(String(packet, pos + 1, labelLen, Charsets.US_ASCII))
            pos += 1 + labelLen
        }
        if (pos + 4 > length) return null // QTYPE + QCLASS
        val questionEnd = pos + 4
        val questionSection = packet.copyOfRange(dnsStart + 12, questionEnd)

        val domain = labels.joinToString(".")
        if (domain.isEmpty()) return null

        return ParsedDnsQuery(sourceAddr, sourcePort, destAddr, destPort, transactionId, questionSection, domain)
    }

    /**
     * Arma una respuesta DNS "bloqueada": un registro A apuntando a
     * 0.0.0.0, empaquetado de vuelta como IPv4+UDP con src/dst invertidos
     * respecto a la consulta original (para que la app que preguntó la
     * reciba como si viniera del servidor DNS real).
     */
    fun buildBlockedResponse(query: ParsedDnsQuery): ByteArray {
        val answer = ByteBuffer.allocate(16).order(ByteOrder.BIG_ENDIAN).apply {
            putShort(0xC00C.toShort()) // puntero al nombre en la sección Question (offset 12)
            putShort(1) // TYPE = A
            putShort(1) // CLASS = IN
            putInt(60) // TTL
            putShort(4) // RDLENGTH
            put(byteArrayOf(0, 0, 0, 0)) // RDATA = 0.0.0.0
        }.array()

        val dnsHeader = ByteBuffer.allocate(12).order(ByteOrder.BIG_ENDIAN).apply {
            put(query.transactionId)
            putShort(0x8180.toShort()) // respuesta estándar, recursión disponible, sin error
            putShort(1) // QDCOUNT
            putShort(1) // ANCOUNT
            putShort(0) // NSCOUNT
            putShort(0) // ARCOUNT
        }.array()

        val dnsMessage = dnsHeader + query.questionSection + answer
        return buildIpv4UdpPacket(
            sourceAddr = query.destAddr,
            sourcePort = query.destPort,
            destAddr = query.sourceAddr,
            destPort = query.sourcePort,
            payload = dnsMessage,
        )
    }

    /** Reempaqueta una respuesta DNS real (bytes crudos recibidos del DNS upstream) como IPv4+UDP. */
    fun buildForwardedResponse(query: ParsedDnsQuery, dnsResponseBytes: ByteArray): ByteArray {
        return buildIpv4UdpPacket(
            sourceAddr = query.destAddr,
            sourcePort = query.destPort,
            destAddr = query.sourceAddr,
            destPort = query.sourcePort,
            payload = dnsResponseBytes,
        )
    }

    private fun buildIpv4UdpPacket(
        sourceAddr: ByteArray,
        sourcePort: Int,
        destAddr: ByteArray,
        destPort: Int,
        payload: ByteArray,
    ): ByteArray {
        val udpLen = UDP_HEADER_LEN + payload.size
        val totalLen = IPV4_HEADER_LEN + udpLen

        val buf = ByteBuffer.allocate(totalLen).order(ByteOrder.BIG_ENDIAN)

        // --- IPv4 header ---
        buf.put(0x45.toByte()) // version 4, IHL 5 (20 bytes, sin opciones)
        buf.put(0) // DSCP/ECN
        buf.putShort(totalLen.toShort())
        buf.putShort(0) // identification
        buf.putShort(0x4000.toShort()) // flags: Don't Fragment
        buf.put(64) // TTL
        buf.put(17) // protocol = UDP
        val checksumPos = buf.position()
        buf.putShort(0) // checksum placeholder
        buf.put(sourceAddr)
        buf.put(destAddr)

        val ipHeaderBytes = buf.array().copyOfRange(0, IPV4_HEADER_LEN)
        val ipChecksum = checksum16(ipHeaderBytes)
        buf.putShort(checksumPos, ipChecksum.toShort())

        // --- UDP header ---
        buf.putShort(sourcePort.toShort())
        buf.putShort(destPort.toShort())
        buf.putShort(udpLen.toShort())
        val udpChecksumPos = buf.position()
        buf.putShort(0) // checksum placeholder (0 = sin verificar, válido en IPv4)
        buf.put(payload)

        // UDP checksum es opcional en IPv4 — lo dejamos en 0 a propósito para
        // no arriesgar un bug de pseudo-header mal calculado que tire el
        // paquete entero; los stacks IPv4 lo aceptan igual.
        buf.putShort(udpChecksumPos, 0)

        return buf.array()
    }

    private fun checksum16(data: ByteArray): Int {
        var sum = 0
        var i = 0
        while (i < data.size) {
            val word = ((data[i].toInt() and 0xFF) shl 8) or
                (if (i + 1 < data.size) (data[i + 1].toInt() and 0xFF) else 0)
            sum += word
            i += 2
        }
        while (sum shr 16 != 0) {
            sum = (sum and 0xFFFF) + (sum shr 16)
        }
        return sum.inv() and 0xFFFF
    }
}

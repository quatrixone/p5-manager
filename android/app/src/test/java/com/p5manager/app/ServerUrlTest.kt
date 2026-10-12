package com.p5manager.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerUrlTest {
    @Test fun `a bare address becomes a plain http url`() {
        assertEquals("http://10.0.0.5:3001", normalizeServerUrl("10.0.0.5:3001"))
        assertEquals("http://10.0.0.5", normalizeServerUrl(" 10.0.0.5 "))
    }

    @Test fun `what the user typed is kept, without the trailing slash`() {
        assertEquals("http://10.0.0.5:3001", normalizeServerUrl("http://10.0.0.5:3001/"))
        assertEquals("https://p5.example.org", normalizeServerUrl("https://p5.example.org"))
        assertEquals("http://10.0.0.5:3001/manager", normalizeServerUrl("http://10.0.0.5:3001/manager/"))
    }

    @Test fun `anything that is not a web address is refused`() {
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("   "))
        assertNull(normalizeServerUrl("javascript:alert(1)"))
        assertNull(normalizeServerUrl("file:///etc/passwd"))
    }

    @Test fun `a server without a name is shown by its host`() {
        assertEquals("10.0.0.5", Server("http://10.0.0.5:3001", "").label)
        assertEquals("Living room", Server("http://10.0.0.5:3001", "Living room").label)
    }
}

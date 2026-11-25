//go:build js && wasm

// TLS for Duragres's Postgres connections, compiled to WebAssembly for a Cloudflare Worker, which has
// no server-side TLS API. The Worker owns the sockets; this code only turns the client's ciphertext
// into plaintext and back, with Go's crypto/tls.
//
// JavaScript calls duragresTlsAccept(certPEM, keyPEM, direct, sendCipher, receivePlain, done) once per
// connection and gets back { cipher(bytes|null), plain(bytes|null), release() }:
//
//	direct         the client began with TLS (libpq's sslnegotiation=direct): require ALPN "postgresql"
//	cipher(bytes)  ciphertext from the client; null when the client closed its side
//	plain(bytes)   plaintext for the client; null to close the TLS session (close_notify)
//	sendCipher     called with ciphertext to write to the client
//	receivePlain   called with plaintext from the client; null at its end
//	done           called once, with an error message or null
//	release()      frees the callbacks; call it once the connection is over, and nothing after it
package main

import (
	"crypto/tls"
	"errors"
	"io"
	"net"
	"sync"
	"syscall/js"
	"time"
)

// queue is an unbounded FIFO of byte chunks: JavaScript callbacks push without blocking the event
// loop, and goroutines pop, waiting while it is empty.
type queue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	chunks [][]byte
	closed bool
}

func newQueue() *queue {
	q := &queue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func (q *queue) push(b []byte) {
	q.mu.Lock()
	q.chunks = append(q.chunks, b)
	q.mu.Unlock()
	q.cond.Signal()
}

func (q *queue) close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Broadcast()
}

// pop returns the next chunk, or false once the queue is closed and drained.
func (q *queue) pop() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.chunks) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.chunks) == 0 {
		return nil, false
	}
	b := q.chunks[0]
	q.chunks[0] = nil // let the popped chunk be collected
	q.chunks = q.chunks[1:]
	return b, true
}

// cipherConn is the net.Conn crypto/tls reads ciphertext from and writes ciphertext to.
type cipherConn struct {
	in      *queue
	pending []byte
	send    js.Value
}

func (c *cipherConn) Read(p []byte) (int, error) {
	for len(c.pending) == 0 {
		b, ok := c.in.pop()
		if !ok {
			return 0, io.EOF
		}
		c.pending = b
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *cipherConn) Write(p []byte) (int, error) {
	c.send.Invoke(toJS(p))
	return len(p), nil
}

func (c *cipherConn) Close() error                     { return nil }
func (c *cipherConn) LocalAddr() net.Addr              { return addr{} }
func (c *cipherConn) RemoteAddr() net.Addr             { return addr{} }
func (c *cipherConn) SetDeadline(time.Time) error      { return nil }
func (c *cipherConn) SetReadDeadline(time.Time) error  { return nil }
func (c *cipherConn) SetWriteDeadline(time.Time) error { return nil }

type addr struct{}

func (addr) Network() string { return "tcp" }
func (addr) String() string  { return "worker" }

func toJS(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(a, b)
	return a
}

func fromJS(v js.Value) []byte {
	b := make([]byte, v.Get("byteLength").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// configs caches the parsed certificate: the PEM strings are the same for every connection.
var (
	configMu   sync.Mutex
	configKey  string
	configLast *tls.Config
)

func config(certPEM, keyPEM string) (*tls.Config, error) {
	configMu.Lock()
	defer configMu.Unlock()
	if configLast != nil && configKey == certPEM+keyPEM {
		return configLast, nil
	}
	cert, err := tls.X509KeyPair([]byte(certPEM), []byte(keyPEM))
	if err != nil {
		return nil, err
	}
	configLast = &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
		// libpq 17+ sends ALPN "postgresql" and requires it for direct TLS (sslnegotiation=direct).
		NextProtos: []string{"postgresql"},
	}
	configKey = certPEM + keyPEM
	return configLast, nil
}

func accept(this js.Value, args []js.Value) any {
	cfg, err := config(args[0].String(), args[1].String())
	direct := args[2].Bool()
	sendCipher, receivePlain, done := args[3], args[4], args[5]
	if err != nil {
		done.Invoke("certificate: " + err.Error())
		return js.Null()
	}

	in, out := newQueue(), newQueue()
	server := tls.Server(&cipherConn{in: in, send: sendCipher}, cfg)
	var once sync.Once
	finish := func(err error) {
		once.Do(func() {
			in.close()
			out.close()
			if err == nil || err == io.EOF {
				done.Invoke(js.Null())
			} else {
				done.Invoke(err.Error())
			}
		})
	}

	// Client to server: handshake, then plaintext until the client's close_notify or EOF.
	go func() {
		if err := server.Handshake(); err != nil {
			finish(err)
			return
		}
		// A direct-TLS client skipped the SSLRequest; ALPN is how it says it speaks Postgres.
		if direct && server.ConnectionState().NegotiatedProtocol != "postgresql" {
			finish(errors.New(`direct TLS requires the ALPN protocol "postgresql"`))
			return
		}
		go func() { // server to client, in order, once the handshake is done
			for {
				b, ok := out.pop()
				if !ok {
					// The database side ended: close the TLS session, which ends the connection.
					_ = server.CloseWrite()
					finish(nil)
					return
				}
				if _, err := server.Write(b); err != nil {
					finish(err)
					return
				}
			}
		}()
		buf := make([]byte, 16384)
		for {
			n, err := server.Read(buf)
			if n > 0 {
				receivePlain.Invoke(toJS(buf[:n]))
			}
			if err != nil {
				receivePlain.Invoke(js.Null())
				finish(err)
				return
			}
		}
	}()

	cipher := js.FuncOf(func(this js.Value, args []js.Value) any {
		if args[0].IsNull() {
			in.close()
		} else {
			in.push(fromJS(args[0]))
		}
		return nil
	})
	plain := js.FuncOf(func(this js.Value, args []js.Value) any {
		if args[0].IsNull() {
			out.close()
		} else {
			out.push(fromJS(args[0]))
		}
		return nil
	})
	var release js.Func
	release = js.FuncOf(func(this js.Value, args []js.Value) any {
		finish(nil)
		cipher.Release()
		plain.Release()
		release.Release()
		return nil
	})
	handle := js.Global().Get("Object").New()
	handle.Set("cipher", cipher)
	handle.Set("plain", plain)
	handle.Set("release", release)
	return handle
}

func main() {
	js.Global().Set("duragresTlsAccept", js.FuncOf(accept))
	select {}
}

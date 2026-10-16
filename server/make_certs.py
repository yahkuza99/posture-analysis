"""Make the clinic's own HTTPS certificates for the posture server.

    python server/make_certs.py --out D:/AHG/posture/certs --ip 192.168.100.63 --dns DESKTOP-3L6R773

Creates
    ca.crt      clinic root certificate — install on each clinic computer ("Trusted Root")
    ca.key      its private key — stays on the server, never copied anywhere
    server.crt  certificate the posture server presents
    server.key  its private key
    install-ahg-cert.cmd  double-click on a clinic computer: trusts ca.crt, opens the app (--url)

The root carries a critical name constraint: it can only vouch for the given IP / host name.
Even if ca.key leaked, it could not be used to impersonate any other website on the computers
that trust it. Re-running keeps an existing CA (computers keep trusting it) and only re-issues
the server certificate; pass --new-ca to start over (every computer must then reinstall ca.crt).
Needs the `cryptography` package.
"""
import argparse
import datetime
import ipaddress
import os

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID


def _write(path, data, private=False):
    with open(path, "wb") as fh:
        fh.write(data)
    if private and os.name != "nt":
        os.chmod(path, 0o600)


def _key_pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())


def make_ca(ips, dnss, years):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "AHG Clinic"),
                      x509.NameAttribute(NameOID.COMMON_NAME, "AHG Clinic Local CA (posture server only)")])
    now = datetime.datetime.now(datetime.timezone.utc)
    permitted = [x509.IPAddress(ipaddress.ip_network(ip + "/32")) for ip in ips] + \
                [x509.DNSName(d) for d in dnss]
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365 * years))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    return key, cert


def make_server_cert(ca_key, ca_cert, ips, dnss, years):
    key = ec.generate_private_key(ec.SECP256R1())
    cn = dnss[0] if dnss else ips[0]
    now = datetime.datetime.now(datetime.timezone.utc)
    sans = [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips] + [x509.DNSName(d) for d in dnss]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)]))
            .issuer_name(ca_cert.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=365 * years))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    return key, cert


INSTALLER = r"""@echo off
chcp 65001 >nul
rem Trust the AHG clinic certificate on this computer, then open Posture Analysis.
rem The certificate can only vouch for the clinic server (name constraint), nothing else.
setlocal
set "CRT=%TEMP%\ahg-clinic-ca.crt"
> "%CRT%" (
{lines}
)
rem elevated = high integrity label (net session is unreliable when the Server service is off)
whoami /groups | find "S-1-16-12288" >nul
if %errorlevel%==0 (
  certutil -f -addstore Root "%CRT%" >nul
) else (
  echo กด Yes ในหน้าต่างที่ขึ้นมา เพื่อให้เครื่องนี้เชื่อใบรับรองของคลินิก
  certutil -f -user -addstore Root "%CRT%" >nul
)
if errorlevel 1 (
  echo ติดตั้งใบรับรองไม่สำเร็จ - แจ้งผู้ดูแลระบบ
  del "%CRT%" >nul 2>&1
  pause
  exit /b 1
)
del "%CRT%" >nul 2>&1
echo ติดตั้งแล้ว - ปิด Chrome/Edge ทุกหน้าต่างแล้วเปิดใหม่ ถ้ายังขึ้นคำเตือน
start "" "{url}"
timeout /t 5 >nul
"""


def write_installer(path, ca_pem, url):
    lines = "\n".join("echo " + ln for ln in ca_pem.decode().strip().splitlines())
    text = INSTALLER.replace("{lines}", lines).replace("{url}", url)
    with open(path, "w", encoding="utf-8", newline="\r\n") as fh:
        fh.write(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--ip", action="append", default=[])
    ap.add_argument("--dns", action="append", default=[])
    ap.add_argument("--years", type=int, default=5, help="server certificate lifetime")
    ap.add_argument("--new-ca", action="store_true")
    ap.add_argument("--url", help="app address opened after installing the certificate")
    a = ap.parse_args()
    if not a.ip and not a.dns:
        ap.error("give at least one --ip or --dns")
    os.makedirs(a.out, exist_ok=True)
    ca_crt, ca_key = os.path.join(a.out, "ca.crt"), os.path.join(a.out, "ca.key")
    if os.path.isfile(ca_crt) and os.path.isfile(ca_key) and not a.new_ca:
        with open(ca_key, "rb") as fh:
            ck = serialization.load_pem_private_key(fh.read(), None)
        with open(ca_crt, "rb") as fh:
            cc = x509.load_pem_x509_certificate(fh.read())
        print("keeping existing CA", cc.fingerprint(hashes.SHA256()).hex(":"))
    else:
        ck, cc = make_ca(a.ip, a.dns, years=10)
        _write(ca_key, _key_pem(ck), private=True)
        _write(ca_crt, cc.public_bytes(serialization.Encoding.PEM))
        print("new CA", cc.fingerprint(hashes.SHA256()).hex(":"))
    sk, sc = make_server_cert(ck, cc, a.ip, a.dns, a.years)
    _write(os.path.join(a.out, "server.key"), _key_pem(sk), private=True)
    _write(os.path.join(a.out, "server.crt"), sc.public_bytes(serialization.Encoding.PEM))
    url = a.url or "https://%s/" % (a.ip[0] if a.ip else a.dns[0])
    write_installer(os.path.join(a.out, "install-ahg-cert.cmd"), cc.public_bytes(serialization.Encoding.PEM), url)
    print("server certificate valid until", sc.not_valid_after_utc.date(), "for", a.ip + a.dns)


if __name__ == "__main__":
    main()

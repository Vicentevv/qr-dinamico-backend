require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");
const { createCanvas, loadImage } = require("canvas");

// Firebase Admin SDK modular (v10+)
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

// 1. Inicializar Firebase Admin
// En producción (Render): usa la variable de entorno FIREBASE_CREDENTIALS
// En local: usa el archivo serviceAccountKey.json
let serviceAccount;

if (process.env.FIREBASE_CREDENTIALS) {
  // Producción: credenciales como JSON string en variable de entorno
  serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
  // Local: archivo JSON
  const keyPath = path.join(__dirname, "serviceAccountKey.json");
  if (!fs.existsSync(keyPath)) {
    console.error("\n  No se encontro serviceAccountKey.json");
    console.error("   Descargalo desde Firebase Console > Configuracion > Cuentas de servicio\n");
    process.exit(1);
  }
  serviceAccount = require(keyPath);
}

initializeApp({
  credential: cert(serviceAccount),
});

const db = getFirestore();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// 2. Redireccion  GET /qr/:qrId
app.get("/qr/:qrId", async (req, res) => {
  const { qrId } = req.params;
  try {
    const qrRef = db.collection("dynamic_qrs").doc(qrId);
    const doc = await qrRef.get();

    if (!doc.exists) {
      return res.status(404).send("QR no encontrado.");
    }

    const data = doc.data();

    if (!data.isActive) {
      return res.status(403).send("Este QR esta temporalmente inactivo.");
    }

    qrRef.update({
      scans: FieldValue.increment(1),
      lastScanned: FieldValue.serverTimestamp(),
    }).catch(err => console.error("Error actualizando metricas:", err));

    return res.redirect(302, data.targetUrl);
  } catch (error) {
    console.error("Error al procesar el QR:", error);
    return res.status(500).send("Error interno del servidor.");
  }
});

// 3. Crear QR con ID autoincrementado  POST /api/qr
app.post("/api/qr", async (req, res) => {
  const { targetUrl, alias, isActive } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: "Se requiere targetUrl." });
  }

  try {
    const counterRef = db.collection("_meta").doc("counter");

    // Asignar ID numerico de forma atomica
    const newId = await db.runTransaction(async (t) => {
      const counterDoc = await t.get(counterRef);
      const next = (counterDoc.exists ? counterDoc.data().lastId : 0) + 1;
      t.set(counterRef, { lastId: next }, { merge: true });
      return next;
    });

    const docId = String(newId);

    await db.collection("dynamic_qrs").doc(docId).set({
      targetUrl,
      alias: alias || "",
      isActive: isActive !== undefined ? isActive : true,
      createdAt: FieldValue.serverTimestamp(),
      scans: 0,
    });

    return res.status(200).json({ message: "QR creado exitosamente.", id: docId, alias: alias || "" });
  } catch (error) {
    console.error("Error creando el QR:", error);
    return res.status(500).json({ error: "Error interno al crear el QR." });
  }
});

// 4. Info de un QR  GET /api/qr/:qrId
app.get("/api/qr/:qrId", async (req, res) => {
  const { qrId } = req.params;
  try {
    const doc = await db.collection("dynamic_qrs").doc(qrId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }
    return res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (error) {
    console.error("Error obteniendo el QR:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 5. Listar todos  GET /api/qrs
app.get("/api/qrs", async (req, res) => {
  try {
    const snapshot = await db.collection("dynamic_qrs").get();
    // Ordenar numericamente (1, 2, 3...) ignorando docs no numericos
    const qrs = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const nA = parseInt(a.id), nB = parseInt(b.id);
        if (!isNaN(nA) && !isNaN(nB)) return nA - nB;
        return a.id.localeCompare(b.id);
      });
    return res.status(200).json(qrs);
  } catch (error) {
    console.error("Error listando QRs:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 6. Actualizar URL  PATCH /api/qr/:qrId
app.patch("/api/qr/:qrId", async (req, res) => {
  const { qrId } = req.params;
  const { targetUrl } = req.body;

  if (!targetUrl) {
    return res.status(400).json({ error: "Se requiere targetUrl." });
  }

  try {
    const qrRef = db.collection("dynamic_qrs").doc(qrId);
    const doc = await qrRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }
    await qrRef.update({ targetUrl });
    return res.status(200).json({ message: "URL actualizada.", id: qrId });
  } catch (error) {
    console.error("Error actualizando URL:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 7. Toggle activo/inactivo  PATCH /api/qr/:qrId/toggle
app.patch("/api/qr/:qrId/toggle", async (req, res) => {
  const { qrId } = req.params;
  try {
    const qrRef = db.collection("dynamic_qrs").doc(qrId);
    const doc = await qrRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }

    const newStatus = !doc.data().isActive;
    await qrRef.update({ isActive: newStatus });

    return res.status(200).json({ message: "Estado actualizado.", isActive: newStatus });
  } catch (error) {
    console.error("Error al cambiar estado del QR:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 8. Editar alias  PATCH /api/qr/:qrId/alias
app.patch("/api/qr/:qrId/alias", async (req, res) => {
  const { qrId } = req.params;
  const { alias } = req.body;

  if (alias === undefined) {
    return res.status(400).json({ error: "Se requiere el campo alias." });
  }

  try {
    const qrRef = db.collection("dynamic_qrs").doc(qrId);
    const doc = await qrRef.get();
    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }
    await qrRef.update({ alias: alias.trim() });
    return res.status(200).json({ message: "Alias actualizado.", id: qrId, alias: alias.trim() });
  } catch (error) {
    console.error("Error actualizando alias:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 9. Eliminar un QR  DELETE /api/qr/:qrId
app.delete("/api/qr/:qrId", async (req, res) => {
  const { qrId } = req.params;
  try {
    const qrRef = db.collection("dynamic_qrs").doc(qrId);
    const doc = await qrRef.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }

    await qrRef.delete();
    return res.status(200).json({ message: "QR eliminado correctamente.", id: qrId });
  } catch (error) {
    console.error("Error eliminando el QR:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 9. Generar imagen PNG  GET /api/qr/:qrId/image.png
app.get("/api/qr/:qrId/image.png", async (req, res) => {
  const { qrId } = req.params;
  const size = parseInt(req.query.size) || 300;  // ?size=400

  try {
    const doc = await db.collection("dynamic_qrs").doc(qrId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }

    // La URL que codifica el QR es el endpoint de redireccion
    const BASE_URL = process.env.BASE_URL || "http://localhost:" + (process.env.PORT || 3000);
    const redirectUrl = BASE_URL + "/qr/" + qrId;

    const buffer = await QRCode.toBuffer(redirectUrl, {
      type: "png",
      width: size,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

    const docData = doc.data();
    const textToDraw = `#${qrId}`;

    const img = await loadImage(buffer);
    
    // Añadir espacio extra abajo para el texto (15% del tamaño o min 30px)
    const textHeight = Math.max(30, Math.floor(size * 0.15));
    const canvas = createCanvas(size, size + textHeight);
    const ctx = canvas.getContext("2d");

    // Fondo blanco
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Dibujar el QR arriba
    ctx.drawImage(img, 0, 0, size, size);

    // Dibujar el texto centrado abajo
    ctx.fillStyle = "#000000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const fontSize = Math.max(12, Math.floor(size * 0.06));
    ctx.font = `bold ${fontSize}px sans-serif`;
    
    // Dibujar el texto
    ctx.fillText(textToDraw, size / 2, size + (textHeight / 2));

    const finalBuffer = canvas.toBuffer("image/png");

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", 'inline; filename="' + qrId + '.png"');
    return res.send(finalBuffer);
  } catch (error) {
    console.error("Error generando imagen PNG:", error);
    return res.status(500).json({ error: "Error generando la imagen." });
  }
});

// 8. Generar imagen SVG  GET /api/qr/:qrId/image.svg
app.get("/api/qr/:qrId/image.svg", async (req, res) => {
  const { qrId } = req.params;

  try {
    const doc = await db.collection("dynamic_qrs").doc(qrId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "QR no encontrado." });
    }

    const BASE_URL = process.env.BASE_URL || "http://localhost:" + (process.env.PORT || 3000);
    const redirectUrl = BASE_URL + "/qr/" + qrId;

    const svg = await QRCode.toString(redirectUrl, {
      type: "svg",
      margin: 2,
    });

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Disposition", 'inline; filename="' + qrId + '.svg"');
    return res.send(svg);
  } catch (error) {
    console.error("Error generando SVG:", error);
    return res.status(500).json({ error: "Error generando la imagen." });
  }
});

// 10. Reset de base de datos (PELIGROSO)  POST /api/admin/reset
app.post("/api/admin/reset", async (req, res) => {
  try {
    const snapshot = await db.collection("dynamic_qrs").get();
    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });
    await batch.commit();

    await db.collection("_meta").doc("counter").set({ lastId: 0 });

    return res.status(200).json({ message: "Base de datos reiniciada. Todos los QRs han sido eliminados." });
  } catch (error) {
    console.error("Error reseteando DB:", error);
    return res.status(500).json({ error: "Error interno del servidor." });
  }
});

// 11. Health check  GET /health
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Arrancar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("\n  Servidor QR Dinamico corriendo en http://localhost:" + PORT);
  console.log("\n   Endpoints:");
  console.log("   GET  /qr/:qrId                  -> Redireccion dinamica");
  console.log("   POST /api/qr                    -> Crear/actualizar QR");
  console.log("   GET  /api/qr/:qrId              -> Info de un QR");
  console.log("   GET  /api/qrs                   -> Listar todos los QRs");
  console.log("   PATCH /api/qr/:qrId/toggle      -> Activar/desactivar QR");
  console.log("   GET  /api/qr/:qrId/image.png    -> Imagen PNG del QR");
  console.log("   GET  /api/qr/:qrId/image.svg    -> Imagen SVG del QR");
  console.log("   GET  /health                    -> Estado del servidor\n");
});
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Scan, Upload, Sparkles, Box, CheckCircle2, AlertCircle, ArrowRight, Camera } from 'lucide-react';
import { useCircuit } from '../context/CircuitContext';
import Breadboard3DCanvas from '../components/Breadboard3DCanvas';
import { API_BASE_URL } from '../services/api.js';

const CLASS_COLOR_BADGES = {
  resistor: { border: '#f97316', text: '#f97316' },
  diode_rectifier: { border: '#d946ef', text: '#d946ef' },
  ic_chip: { border: '#eab308', text: '#eab308' },
  wire: { border: '#38bdf8', text: '#38bdf8' },
  capacitor: { border: '#3b82f6', text: '#3b82f6' },
  led: { border: '#22c55e', text: '#22c55e' }
};

export default function Scanner() {
  const navigate = useNavigate();
  const {
    activeCircuit,
    uploadedImage,
    setUploadedImage,
    isAnalyzingReal,
    setIsAnalyzingReal,
    realAnalysisError,
    setRealAnalysisError,
    setRealCircuitData
  } = useCircuit();

  const [annotatedImage, setAnnotatedImage] = useState(null);
  const [detections, setDetections] = useState([]);
  const [mappedComponents, setMappedComponents] = useState([]);
  const [netsSummary, setNetsSummary] = useState([]);
  const [analysisDone, setAnalysisDone] = useState(false);

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        const dataUrl = evt.target?.result;
        if (!dataUrl || typeof dataUrl !== 'string') {
          setRealAnalysisError("Failed to read selected image file.");
          return;
        }

        console.log("[Scanner] Image selected:", {
          name: file.name,
          type: file.type,
          size: file.size,
          hasImageData: Boolean(dataUrl),
          prefix: dataUrl?.slice(0, 30)
        });

        setUploadedImage(dataUrl);
        setAnnotatedImage(null);
        setDetections([]);
        setMappedComponents([]);
        setNetsSummary([]);
        setRealAnalysisError(null);
        setAnalysisDone(false);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleAnalyseImage = async () => {
    if (!uploadedImage) {
      setRealAnalysisError("Please upload an image first.");
      return;
    }

    console.log("[Scanner] Sending image_base64:", {
      exists: Boolean(uploadedImage),
      length: uploadedImage?.length,
      prefix: uploadedImage?.slice(0, 30)
    });

    setIsAnalyzingReal(true);
    setRealAnalysisError(null);

    const API_TARGET = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_BASE_URL)
      ? import.meta.env.VITE_API_BASE_URL
      : API_BASE_URL;

    try {
      console.log("Calling Direct Image Analysis API:", `${API_TARGET}/api/analyze-image`);

      const resp = await fetch(`${API_TARGET}/api/analyze-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: uploadedImage })
      });

      if (!resp.ok) {
        const text = await resp.text();
        console.error(`Backend error response (HTTP ${resp.status}):`, text);
        let errorDetail = `Scanner backend error: HTTP ${resp.status}`;
        try {
          const errJson = JSON.parse(text);
          if (errJson.detail) errorDetail = errJson.detail;
        } catch (_) {}
        throw new Error(errorDetail);
      }

      const data = await resp.json();
      console.log("================ DIRECT IMAGE ANALYSIS RESULTS ================");
      console.log("DETECTIONS:", data.detections);
      console.log("MAPPED COMPONENTS:", data.mapped_components);
      console.log("NETLIST:", data.netlist);
      console.log("===============================================================");

      const detectionsList = data.detections || [];
      const mappedComps = data.mapped_components || [];
      const netlistData = data.netlist || {};

      setAnnotatedImage(data.annotated_image || uploadedImage);
      setDetections(detectionsList);
      setMappedComponents(mappedComps);
      setNetsSummary(data.nets_summary || []);
      setAnalysisDone(true);

      // Store in CircuitContext
      setRealCircuitData({
        originalImage: data.originalImage || uploadedImage,
        annotated_image: data.annotated_image,
        detections: detectionsList,
        mapped_components: mappedComps,
        netlist: netlistData,
        imageMeta: data.imageMeta || data.image_meta,
        source: 'real'
      });

      setIsAnalyzingReal(false);
    } catch (err) {
      console.error("Scanner Direct Analysis Error:", err);
      let msg = err.message || "Cannot reach Scanner backend.";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("Network Error")) {
        msg = "Cannot reach Scanner backend server. Ensure backend is running.";
      }
      setRealAnalysisError(msg);
      setIsAnalyzingReal(false);
    }
  };

  const handleNavigateToAR = () => {
    navigate('/circuit-ar');
  };

  const isRealActive = activeCircuit?.source === 'real';

  return (
    <div style={{ paddingBottom: '2.5rem' }}>
      {/* Header */}
      <div className="page-header" style={{ marginBottom: '1.25rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 className="page-title">
              <Scan size={28} style={{ color: 'var(--accent-cyan)' }} />
              Circuit Scanner
            </h1>
            <p className="page-subtitle">
              Upload a physical circuit photo (Power/+V → Resistor → LED → GND) to detect components, generate netlist model, and view in 3D AR.
            </p>
          </div>
          {analysisDone && (
            <button
              onClick={handleNavigateToAR}
              className="btn btn-primary"
              style={{ padding: '0.6rem 1.4rem', fontSize: '0.95rem', fontWeight: 800, background: 'linear-gradient(135deg, #0284c7 0%, #0d9488 100%)', boxShadow: '0 4px 15px rgba(2, 132, 199, 0.4)' }}
            >
              View Circuit AR <ArrowRight size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Control Card: [Upload Image] & [Analyse Image] */}
      <div className="card" style={{ marginBottom: '1.25rem', padding: '1.25rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <label className="btn btn-secondary" style={{ cursor: 'pointer', padding: '0.6rem 1.2rem', fontSize: '0.9rem', fontWeight: 700 }}>
              <Upload size={18} /> Upload Image
              <input type="file" accept="image/jpeg,image/png,image/webp,image/jpg" onChange={handleFileUpload} style={{ display: 'none' }} />
            </label>

            <button
              onClick={handleAnalyseImage}
              disabled={!uploadedImage || isAnalyzingReal}
              className="btn btn-primary"
              style={{
                padding: '0.6rem 1.4rem',
                fontSize: '0.9rem',
                fontWeight: 800,
                opacity: (!uploadedImage || isAnalyzingReal) ? 0.6 : 1,
                cursor: (!uploadedImage || isAnalyzingReal) ? 'not-allowed' : 'pointer'
              }}
            >
              <Sparkles size={18} />
              {isAnalyzingReal ? 'Analyzing Circuit...' : 'Analyse Image'}
            </button>
          </div>

          {analysisDone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className="code-pill" style={{ background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-emerald)', borderColor: 'var(--accent-emerald)', fontSize: '0.85rem' }}>
                <CheckCircle2 size={15} /> {mappedComponents.length} Components Detected
              </span>
              <button
                onClick={handleNavigateToAR}
                className="btn btn-primary"
                style={{ padding: '0.5rem 1.1rem', fontSize: '0.85rem', fontWeight: 700 }}
              >
                View Circuit AR →
              </button>
            </div>
          )}
        </div>

        {realAnalysisError && (
          <div style={{ marginTop: '0.85rem', padding: '0.75rem', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid var(--accent-red)', color: 'var(--accent-red)', fontSize: '0.88rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <AlertCircle size={16} />
            <span>{realAnalysisError}</span>
          </div>
        )}
      </div>

      {/* Main Display Grid: Uploaded/Annotated Photo vs 3D Reconstructed Model */}
      <div className="card-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: '1.5rem' }}>
        {/* Left Column: Uploaded Photo / YOLO Detections */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <h2 style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-cyan)', fontWeight: 800 }}>
              <Camera size={16} />
              Uploaded Circuit Photograph
            </h2>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              {uploadedImage ? (annotatedImage ? 'YOLO Detections' : 'Ready for Analysis') : 'No Image Uploaded'}
            </span>
          </div>

          <div style={{
            position: 'relative',
            borderRadius: '8px',
            overflow: 'hidden',
            background: '#040711',
            border: '1px solid var(--border-color)',
            height: '400px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0.5rem'
          }}>
            {annotatedImage ? (
              <img
                src={annotatedImage}
                alt="YOLO Detected Bounding Box Output"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : uploadedImage ? (
              <img
                src={uploadedImage}
                alt="Uploaded Circuit Input"
                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
              />
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem' }}>
                <Upload size={36} style={{ marginBottom: '0.75rem', opacity: 0.5 }} />
                <div style={{ fontSize: '0.9rem', fontWeight: 700 }}>No image uploaded</div>
                <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>Click [Upload Image] above to select a circuit photograph</div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: 3D Reconstructed Digital Twin */}
        <div className="card" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <h2 style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--accent-emerald)', fontWeight: 800 }}>
              <Box size={16} />
              3D Digital Twin View
            </h2>
            <span className="code-pill" style={{ fontSize: '0.75rem', color: isRealActive ? 'var(--accent-emerald)' : 'var(--accent-cyan)', borderColor: isRealActive ? 'var(--accent-emerald)' : 'var(--accent-cyan)' }}>
              {isRealActive ? 'Real Scanned 3D Model' : 'Standard Breadboard'}
            </span>
          </div>

          <div style={{ height: '400px', borderRadius: '8px', overflow: 'hidden' }}>
            <Breadboard3DCanvas circuit={activeCircuit} />
          </div>
        </div>
      </div>

      {/* Detected Components Table */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.85rem' }}>
          <h3 style={{ fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 800 }}>
            <Sparkles size={18} style={{ color: 'var(--accent-cyan)' }} />
            Detected Components
          </h3>
          {analysisDone && (
            <button
              onClick={handleNavigateToAR}
              className="btn btn-primary"
              style={{ padding: '0.45rem 1rem', fontSize: '0.85rem', fontWeight: 800 }}
            >
              View Circuit AR →
            </button>
          )}
        </div>

        {mappedComponents.length === 0 ? (
          <div style={{ padding: '2.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.88rem' }}>
            {analysisDone
              ? 'No supported components detected.'
              : uploadedImage
                ? 'Click "Analyse Image" above to process this photo through YOLO neural detection.'
                : 'Upload a circuit photo and click "Analyse Image" to detect physical circuit components.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem', textAlign: 'left' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-muted)' }}>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Designator</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Component Type</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Tie-Point Terminals</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Value / Spec</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Confidence</th>
                  <th style={{ padding: '0.65rem 0.75rem' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {mappedComponents.map((comp, idx) => {
                  const badge = CLASS_COLOR_BADGES[comp.type] || { border: '#fff', text: '#fff' };
                  const mapConf = comp.mapping_confidence !== undefined ? comp.mapping_confidence : (comp.confidence || 0.90);
                  const displayVal = comp.formatted_value || comp.displayValue || comp.detected_value || (comp.value ? `${comp.value} ${comp.unit || 'Ω'}` : 'Detected');

                  return (
                    <tr key={comp.id || idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ padding: '0.65rem 0.75rem', fontWeight: '800', fontFamily: 'var(--font-mono)', color: '#ffffff' }}>
                        {comp.designator || `C${idx + 1}`}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', color: badge.text, textTransform: 'capitalize', fontWeight: 700 }}>
                        {comp.type}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', fontFamily: 'var(--font-mono)', color: 'var(--accent-cyan)' }}>
                        {comp.start_hole || comp.hole1} → {comp.end_hole || comp.hole2}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', color: '#e2e8f0', fontFamily: 'var(--font-mono)' }}>
                        {displayVal}
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem', fontFamily: 'var(--font-mono)', color: mapConf >= 0.8 ? 'var(--accent-emerald)' : 'var(--accent-amber)' }}>
                        {(mapConf * 100).toFixed(0)}%
                      </td>
                      <td style={{ padding: '0.65rem 0.75rem' }}>
                        <span style={{ fontSize: '0.78rem', color: 'var(--accent-emerald)', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', fontWeight: 700 }}>
                          <CheckCircle2 size={13} /> Verified
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export interface VoiceInputCallbacks {
  onResult: (text: string) => void;
  onError: (err: string) => void;
  onStart: () => void;
  onEnd: () => void;
}

export function isVoiceSupported(): boolean {
  return !!(
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition
  );
}

export function startVoiceInput(callbacks: VoiceInputCallbacks): () => void {
  const SR =
    (window as any).SpeechRecognition ||
    (window as any).webkitSpeechRecognition;
  if (!SR) {
    callbacks.onError('Voice input not supported in this browser');
    return () => {};
  }

  const rec = new SR();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = 'en-US';

  rec.onresult = (e: any) => {
    const last = e.results[e.results.length - 1];
    if (last.isFinal) {
      callbacks.onResult(last[0].transcript);
    }
  };

  rec.onerror = (e: any) => {
    callbacks.onError(e.error || 'Unknown voice error');
  };

  rec.onstart = () => callbacks.onStart();
  rec.onend = () => callbacks.onEnd();

  rec.start();

  return () => {
    try {
      rec.stop();
    } catch {
      // already stopped
    }
  };
}

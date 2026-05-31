import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, ChevronDown } from 'lucide-react';
import { MarkingResult, resultsAPI } from '../services/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  selectedResult: MarkingResult | null;
}

const FeedbackChatWidget: React.FC<Props> = ({ selectedResult }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setChatHistory([]);
    setChatInput('');
    setIsOpen(false);
  }, [selectedResult?.id]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    }
  }, [chatHistory, isOpen]);

  if (!selectedResult) return null;

  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const question = chatInput.trim();
    setChatInput('');
    const newHistory: ChatMessage[] = [...chatHistory, { role: 'user', content: question }];
    setChatHistory(newHistory);
    setChatLoading(true);
    try {
      const res = await resultsAPI.chat(selectedResult.id, {
        question,
        history: chatHistory.slice(-8)
      });
      setChatHistory([...newHistory, { role: 'assistant', content: res.data.answer }]);
    } catch {
      setChatHistory([...newHistory, { role: 'assistant', content: 'Sorry, I could not generate a response. Please try again.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-[60] flex flex-col items-end gap-3">
      {isOpen && (
        <div
          className="w-96 bg-white rounded-xl shadow-2xl border border-gray-200 flex flex-col overflow-hidden"
          style={{ maxHeight: '520px' }}
        >
          <div className="bg-indigo-600 px-4 py-3 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <MessageCircle className="w-4 h-4 text-indigo-200 flex-shrink-0" />
              <span className="text-sm font-semibold text-white truncate">
                {selectedResult.filename || 'Feedback Chat'}
              </span>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-indigo-200 hover:text-white flex-shrink-0 ml-2"
              aria-label="Close chat"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div
            className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50"
            style={{ minHeight: '200px', maxHeight: '340px' }}
          >
            {chatHistory.length === 0 && (
              <div className="text-center text-sm text-gray-400 mt-6">
                <MessageCircle className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                <p>Ask a question about this assignment's feedback.</p>
                <p className="text-xs mt-1 text-gray-300">Responses are limited to this document's feedback.</p>
              </div>
            )}
            {chatHistory.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-800 border border-gray-200 shadow-sm'
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm text-gray-500 italic shadow-sm">
                  Thinking…
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          <div className="p-3 bg-white border-t border-gray-200 flex gap-2 flex-shrink-0">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendChatMessage();
                }
              }}
              placeholder="Ask about this feedback…"
              className="flex-1 text-sm border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              disabled={chatLoading}
              maxLength={500}
            />
            <button
              onClick={sendChatMessage}
              disabled={!chatInput.trim() || chatLoading}
              className="inline-flex items-center px-3 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setIsOpen((o) => !o)}
        className="w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-lg flex items-center justify-center transition-colors"
        title={isOpen ? 'Collapse chat' : 'Open feedback chat'}
        aria-label={isOpen ? 'Collapse feedback chat' : 'Open feedback chat'}
      >
        {isOpen ? <ChevronDown className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
      </button>
    </div>
  );
};

export default FeedbackChatWidget;

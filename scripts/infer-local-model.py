#!/usr/bin/env python3
"""
Local Model Inference Script

Runs inference using a trained local model.

Usage:
    python scripts/infer-local-model.py --model ./models/markmate-model --text "Your input text here"
"""

import json
import argparse
import torch
from transformers import AutoTokenizer, AutoModelForSequenceClassification
import sys

def load_model(model_path: str):
    """Load trained model and tokenizer."""
    print(f"Loading model from {model_path}...", file=sys.stderr)
    
    tokenizer = AutoTokenizer.from_pretrained(model_path)
    model = AutoModelForSequenceClassification.from_pretrained(model_path)
    model.eval()
    
    return model, tokenizer

def predict(model, tokenizer, text: str, max_length: int = 512):
    """Predict score for given text."""
    # Tokenize
    inputs = tokenizer(
        text,
        truncation=True,
        padding='max_length',
        max_length=max_length,
        return_tensors='pt'
    )
    
    # Predict
    with torch.no_grad():
        outputs = model(**inputs)
        logits = outputs.logits
    
    # Get normalized score (0-1)
    normalized_score = torch.sigmoid(logits).item()
    
    return normalized_score

def main():
    parser = argparse.ArgumentParser(description='Run inference with local model')
    parser.add_argument('--model', required=True, help='Path to trained model')
    parser.add_argument('--text', required=True, help='Input text to score')
    parser.add_argument('--max-length', type=int, default=512, help='Maximum sequence length')
    
    args = parser.parse_args()
    
    try:
        # Load model
        model, tokenizer = load_model(args.model)
        
        # Predict
        normalized_score = predict(model, tokenizer, args.text, args.max_length)
        
        # Output result as JSON
        result = {
            'normalized_score': normalized_score,
            'confidence': 0.8  # Placeholder - could be improved with uncertainty estimation
        }
        
        print(json.dumps(result))
        
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()






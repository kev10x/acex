#!/usr/bin/env python3
"""
Local Model Training Script for Acexen

Trains a local transformer model on your marking data.
Uses Hugging Face Transformers library.

Requirements:
    pip install transformers torch datasets scikit-learn

Usage:
    python scripts/train-local-model.py --data training_data.json --output ./models/acexen-model
"""

import json
import argparse
import os
from pathlib import Path
from typing import List, Dict, Any
import torch
from transformers import (
    AutoTokenizer, 
    AutoModelForSequenceClassification,
    TrainingArguments,
    Trainer,
    DataCollatorWithPadding
)
from datasets import Dataset
from sklearn.model_selection import train_test_split
import numpy as np
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

def load_training_data(data_path: str) -> List[Dict[str, Any]]:
    """Load training data from JSON file."""
    with open(data_path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    if isinstance(data, dict) and 'data' in data:
        return data['data']
    elif isinstance(data, list):
        return data
    else:
        raise ValueError("Invalid data format. Expected list or dict with 'data' key.")

def prepare_examples(data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Prepare training examples from raw data."""
    examples = []
    
    for item in data:
        if not item.get('assignment_text') or not item.get('scores'):
            continue
        
        # Build input text: rubric + assignment
        rubric_text = format_rubric(item['rubric'])
        assignment_text = item['assignment_text'][:4000]  # Limit length
        input_text = f"Rubric:\n{rubric_text}\n\nAssignment:\n{assignment_text}"
        
        # Build target: total score (normalized to 0-1)
        total_score = item.get('total_score', 0)
        max_points = item['rubric'].get('total_points', 100)
        normalized_score = total_score / max_points if max_points > 0 else 0
        
        examples.append({
            'text': input_text,
            'score': normalized_score,
            'raw_score': total_score,
            'max_points': max_points
        })
    
    return examples

def format_rubric(rubric: Dict[str, Any]) -> str:
    """Format rubric for prompt."""
    text = f"{rubric.get('name', 'Rubric')}\n"
    text += f"Total Points: {rubric.get('total_points', 0)}\n\n"
    text += "Criteria:\n"
    
    criteria = rubric.get('criteria', [])
    if isinstance(criteria, list):
        for i, criterion in enumerate(criteria, 1):
            text += f"{i}. {criterion.get('name', 'Criterion')} "
            text += f"({criterion.get('max_points', 0)} points)\n"
            if criterion.get('description'):
                text += f"   {criterion['description']}\n"
    
    return text

def tokenize_function(examples, tokenizer, max_length=512):
    """Tokenize examples for model input."""
    return tokenizer(
        examples['text'],
        truncation=True,
        padding='max_length',
        max_length=max_length,
        return_tensors='pt'
    )

def compute_metrics(eval_pred):
    """Compute evaluation metrics."""
    predictions, labels = eval_pred
    predictions = np.clip(predictions, 0, 1)  # Clamp to [0, 1]
    
    mse = mean_squared_error(labels, predictions)
    mae = mean_absolute_error(labels, predictions)
    r2 = r2_score(labels, predictions)
    
    return {
        'mse': mse,
        'mae': mae,
        'r2': r2,
        'rmse': np.sqrt(mse)
    }

class ScoreRegressionModel(torch.nn.Module):
    """Custom model for score regression."""
    def __init__(self, base_model_name='distilbert-base-uncased'):
        super().__init__()
        self.base_model = AutoModelForSequenceClassification.from_pretrained(
            base_model_name,
            num_labels=1,
            problem_type="regression"
        )
    
    def forward(self, **inputs):
        return self.base_model(**inputs)

def train_model(
    data_path: str = None,
    output_dir: str = './models/acexen-model',
    base_model: str = 'distilbert-base-uncased',
    epochs: int = 3,
    batch_size: int = 8,
    learning_rate: float = 2e-5,
    train_split: float = 0.8,
    max_length: int = 512,
    examples: List[Dict[str, Any]] = None
):
    """Train the local model."""
    
    print("🚀 Starting local model training...\n")
    
    # Load and prepare data
    if examples is not None:
        # Use provided examples directly
        print(f"📊 Using {len(examples)} provided examples")
        prepared_examples = examples
    else:
        # Load from file
        print("📊 Loading training data...")
        raw_data = load_training_data(data_path)
        print(f"   Loaded {len(raw_data)} examples")
        
        prepared_examples = prepare_examples(raw_data)
    
    print(f"   Prepared {len(prepared_examples)} valid examples")
    
    if len(prepared_examples) < 10:
        raise ValueError("Not enough training examples. Need at least 10 examples.")
    
    # Split data
    train_examples, eval_examples = train_test_split(
        prepared_examples,
        test_size=1 - train_split,
        random_state=42
    )
    
    print(f"   Training set: {len(train_examples)} examples")
    print(f"   Validation set: {len(eval_examples)} examples\n")
    
    # Create datasets
    train_dataset = Dataset.from_list(train_examples)
    eval_dataset = Dataset.from_list(eval_examples)
    
    # Load tokenizer and model
    print(f"🤖 Loading base model: {base_model}...")
    tokenizer = AutoTokenizer.from_pretrained(base_model)
    model = AutoModelForSequenceClassification.from_pretrained(
        base_model,
        num_labels=1,
        problem_type="regression"
    )
    
    # Tokenize datasets
    print("🔤 Tokenizing datasets...")
    train_dataset = train_dataset.map(
        lambda x: tokenize_function(x, tokenizer, max_length),
        batched=True,
        remove_columns=['text']
    )
    eval_dataset = eval_dataset.map(
        lambda x: tokenize_function(x, tokenizer, max_length),
        batched=True,
        remove_columns=['text']
    )
    
    # Set format for PyTorch
    train_dataset.set_format('torch')
    eval_dataset.set_format('torch')
    
    # Training arguments
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=batch_size,
        per_device_eval_batch_size=batch_size,
        learning_rate=learning_rate,
        weight_decay=0.01,
        logging_dir=f'{output_dir}/logs',
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="rmse",
        greater_is_better=False,
        save_total_limit=3,
        warmup_steps=100,
    )
    
    # Data collator
    data_collator = DataCollatorWithPadding(tokenizer=tokenizer)
    
    # Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        data_collator=data_collator,
        compute_metrics=compute_metrics,
    )
    
    # Train
    print("🏋️  Training model...\n")
    train_result = trainer.train()
    
    # Save model and tokenizer
    print(f"\n💾 Saving model to {output_dir}...")
    trainer.save_model()
    tokenizer.save_pretrained(output_dir)
    
    # Save metadata
    metadata = {
        'base_model': base_model,
        'training_examples': len(train_examples),
        'validation_examples': len(eval_examples),
        'epochs': epochs,
        'batch_size': batch_size,
        'learning_rate': learning_rate,
        'max_length': max_length,
        'train_loss': train_result.training_loss,
    }
    
    with open(f'{output_dir}/metadata.json', 'w') as f:
        json.dump(metadata, f, indent=2)
    
    print("✅ Training complete!")
    print(f"   Model saved to: {output_dir}")
    print(f"   Training loss: {train_result.training_loss:.4f}")
    
    # Evaluate
    print("\n📊 Evaluating model...")
    eval_results = trainer.evaluate()
    print(f"   Validation RMSE: {eval_results.get('eval_rmse', 'N/A'):.4f}")
    print(f"   Validation MAE: {eval_results.get('eval_mae', 'N/A'):.4f}")
    print(f"   Validation R²: {eval_results.get('eval_r2', 'N/A'):.4f}")
    
    return model, tokenizer, metadata

def main():
    parser = argparse.ArgumentParser(description='Train local model for Acexen')
    parser.add_argument('--data', required=True, help='Path to training data JSON file')
    parser.add_argument('--output', default='./models/acexen-model', help='Output directory for model')
    parser.add_argument('--base-model', default='distilbert-base-uncased', 
                       help='Base model to fine-tune (default: distilbert-base-uncased)')
    parser.add_argument('--epochs', type=int, default=3, help='Number of training epochs')
    parser.add_argument('--batch-size', type=int, default=8, help='Batch size')
    parser.add_argument('--learning-rate', type=float, default=2e-5, help='Learning rate')
    parser.add_argument('--train-split', type=float, default=0.8, help='Train/validation split ratio')
    parser.add_argument('--max-length', type=int, default=512, help='Maximum sequence length')
    
    args = parser.parse_args()
    
    # Create output directory
    os.makedirs(args.output, exist_ok=True)
    
    # Check if CUDA is available
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"🖥️  Using device: {device}\n")
    
    try:
        train_model(
            data_path=args.data,
            output_dir=args.output,
            base_model=args.base_model,
            epochs=args.epochs,
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            train_split=args.train_split,
            max_length=args.max_length
        )
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0

if __name__ == '__main__':
    exit(main())


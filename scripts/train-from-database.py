#!/usr/bin/env python3
"""
Train Local Model Directly from Database

This script connects to the Acexen database, exports training data,
and trains a local model in one go.

Usage:
    python scripts/train-from-database.py --output ./models/acexen-model --epochs 3
"""

import json
import argparse
import os
import sys
from pathlib import Path

# Add parent directory to path to import database connection
sys.path.insert(0, str(Path(__file__).parent.parent))

try:
    import sqlite3
    import pymysql
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError as e:
    print(f"❌ Missing database library: {e}")
    print("Install with: pip install pymysql psycopg2-binary")
    sys.exit(1)

# Import training script functions (inline to avoid import issues)
def format_rubric(rubric):
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

def prepare_examples(data):
    """Prepare training examples from raw data."""
    examples = []
    
    for item in data:
        if not item.get('scores'):
            continue
        
        # If no assignment text, train on rubric + scores only
        # This still works - model learns rubric-to-score mapping
        
        # Build input text: rubric + assignment (if available)
        rubric_text = format_rubric(item['rubric'])
        assignment_text = item.get('assignment_text', '')
        
        if assignment_text and assignment_text.strip() and not assignment_text.startswith('['):
            # Has valid assignment text
            assignment_text = assignment_text[:4000]  # Limit length
            input_text = f"Rubric:\n{rubric_text}\n\nAssignment:\n{assignment_text}"
        else:
            # No assignment text - train on rubric + scores only
            input_text = f"Rubric:\n{rubric_text}\n\nScore this rubric."
        
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

# Try to import PyTorch and transformers
try:
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
except ImportError as e:
    print(f"❌ Missing ML library: {e}")
    print("Install with: pip install transformers torch datasets scikit-learn numpy")
    sys.exit(1)

def get_db_connection():
    """Connect to database based on environment or config."""
    # Check for database type from environment or config file
    db_type = os.getenv('DB_TYPE', 'sqlite').lower()
    
    if db_type == 'sqlite':
        db_path = os.getenv('DB_PATH', './database.sqlite')
        if not os.path.exists(db_path):
            db_path = os.path.join(Path(__file__).parent.parent, 'database.sqlite')
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        return conn
    
    elif db_type == 'mysql':
        conn = pymysql.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=int(os.getenv('DB_PORT', 3306)),
            user=os.getenv('DB_USER', 'root'),
            password=os.getenv('DB_PASSWORD', ''),
            database=os.getenv('DB_NAME', 'acexen'),
            cursorclass=pymysql.cursors.DictCursor
        )
        return conn
    
    elif db_type == 'postgresql':
        conn = psycopg2.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=int(os.getenv('DB_PORT', 5432)),
            user=os.getenv('DB_USER', 'postgres'),
            password=os.getenv('DB_PASSWORD', ''),
            database=os.getenv('DB_NAME', 'acexen')
        )
        return conn
    
    else:
        raise ValueError(f"Unknown database type: {db_type}")

def check_column_exists(conn, table, column):
    """Check if a column exists in a table."""
    db_type = os.getenv('DB_TYPE', 'sqlite').lower()
    
    if db_type == 'sqlite':
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({table})")
        columns = [row[1] for row in cursor.fetchall()]
        return column in columns
    elif db_type == 'mysql':
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(*) as count 
            FROM information_schema.COLUMNS 
            WHERE table_schema = DATABASE() 
            AND table_name = %s 
            AND column_name = %s
        """, (table, column))
        result = cursor.fetchone()
        return (result.get('count', 0) if isinstance(result, dict) else result[0]) > 0
    elif db_type == 'postgresql':
        cursor = conn.cursor()
        cursor.execute("""
            SELECT COUNT(*) as count 
            FROM information_schema.columns 
            WHERE table_name = %s 
            AND column_name = %s
        """, (table, column))
        result = cursor.fetchone()
        return (result[0] if isinstance(result, tuple) else result.get('count', 0)) > 0
    return False

def fetch_training_data(conn, include_text=True, only_current=True, min_score_count=1):
    """Fetch training data directly from database."""
    print("📊 Fetching training data from database...")
    
    # Check which columns exist
    has_strictness = check_column_exists(conn, 'marking_results', 'strictness_level')
    has_provider = check_column_exists(conn, 'marking_results', 'provider')
    has_corrections = check_column_exists(conn, 'marking_results', 'corrections')
    has_version = check_column_exists(conn, 'marking_results', 'version')
    has_is_current = check_column_exists(conn, 'marking_results', 'is_current')
    has_rubric_type = check_column_exists(conn, 'rubrics', 'rubric_type')
    
    # Build query with conditional columns
    query = """
        SELECT 
            mr.id as result_id,
            mr.assignment_id,
            mr.rubric_id,
            mr.student_name,
            mr.scores,
            mr.feedback,
            mr.total_score"""
    
    if has_strictness:
        query += ", mr.strictness_level"
    else:
        query += ", NULL as strictness_level"
    
    if has_provider:
        query += ", mr.provider"
    else:
        query += ", NULL as provider"
    
    if has_corrections:
        query += ", mr.corrections"
    else:
        query += ", NULL as corrections"
    
    if has_version:
        query += ", mr.version"
    else:
        query += ", 1 as version"
    
    if has_is_current:
        query += ", mr.is_current"
    else:
        query += ", 1 as is_current"
    
    query += """,
            mr.marked_at,
            a.filename,
            a.file_path,
            a.uploaded_at,
            r.name as rubric_name,
            r.total_points as rubric_total_points,
            r.criteria as rubric_criteria"""
    
    if has_rubric_type:
        query += ", r.rubric_type"
    else:
        query += ", NULL as rubric_type"
    
    query += """
        FROM marking_results mr
        INNER JOIN assignments a ON mr.assignment_id = a.id
        INNER JOIN rubrics r ON mr.rubric_id = r.id
        WHERE 1=1
    """
    
    params = []
    
    if only_current and has_is_current:
        query += " AND mr.is_current = 1"
    
    query += " ORDER BY mr.marked_at DESC"
    
    # Execute query
    cursor = conn.cursor()
    cursor.execute(query, params)
    
    # Fetch results
    if hasattr(cursor, 'fetchall'):
        rows = cursor.fetchall()
    else:
        rows = list(cursor)
    
    print(f"   Found {len(rows)} marking results")
    
    if len(rows) == 0:
        print("   ⚠️  No marking results found in database")
        print("   Make sure you have marked some assignments first")
        return []
    
    # Process rows
    training_data = []
    processed = 0
    skipped = 0
    skipped_reasons = {'no_scores': 0, 'min_score_count': 0, 'parse_error': 0}
    
    for row in rows:
        try:
            # Convert row to dict
            if isinstance(row, dict):
                row_dict = row
            elif hasattr(row, 'keys'):  # SQLite Row or similar
                row_dict = {key: row[key] for key in row.keys()}
            elif hasattr(row, '_asdict'):  # Named tuple
                row_dict = row._asdict()
            else:
                # Try to get column names from cursor
                try:
                    if hasattr(cursor, 'description') and cursor.description:
                        column_names = [desc[0] for desc in cursor.description]
                        row_dict = dict(zip(column_names, row))
                    else:
                        row_dict = dict(row) if hasattr(row, '__iter__') else {}
                except:
                    row_dict = {}
            
            # Parse JSON fields
            scores = json.loads(row_dict['scores']) if isinstance(row_dict['scores'], str) else row_dict['scores']
            rubric_criteria = json.loads(row_dict['rubric_criteria']) if isinstance(row_dict['rubric_criteria'], str) else row_dict['rubric_criteria']
            corrections = json.loads(row_dict['corrections']) if row_dict.get('corrections') and isinstance(row_dict['corrections'], str) else row_dict.get('corrections')
            
            # Filter by minimum score count
            if not scores:
                skipped += 1
                skipped_reasons['no_scores'] += 1
                continue
            
            if not isinstance(scores, list):
                skipped += 1
                skipped_reasons['parse_error'] += 1
                continue
            
            if len(scores) < min_score_count:
                skipped += 1
                skipped_reasons['min_score_count'] += 1
                continue
            
            # Extract assignment text if requested
            # Note: PDF text extraction requires Node.js service
            # For database training, we train on rubric + scores only (no assignment text)
            # User can export via UI first to get text, or use --include-text=False
            assignment_text = None
            
            # Build training example
            example = {
                'id': row_dict['result_id'],
                'assignment_id': row_dict['assignment_id'],
                'rubric_id': row_dict['rubric_id'],
                'student_name': row_dict.get('student_name'),
                'filename': row_dict['filename'],
                'uploaded_at': str(row_dict.get('uploaded_at', '')),
                'marked_at': str(row_dict.get('marked_at', '')),
                'version': row_dict.get('version', 1),
                'is_current': row_dict.get('is_current', 1),
                
                # Input features
                'assignment_text': assignment_text,
                'rubric': {
                    'name': row_dict.get('rubric_name', 'Rubric'),
                    'total_points': row_dict.get('rubric_total_points', 100),
                    'criteria': rubric_criteria or [],
                    'rubric_type': row_dict.get('rubric_type')
                },
                'strictness_level': row_dict.get('strictness_level'),
                'provider': row_dict.get('provider'),
                
                # Output targets
                'scores': scores or [],
                'total_score': row_dict.get('total_score', 0),
                'feedback': row_dict.get('feedback', ''),
                'corrections': corrections
            }
            
            training_data.append(example)
            processed += 1
            
            if processed % 10 == 0:
                print(f"   Processed {processed}/{len(rows)}...")
        
        except Exception as e:
            print(f"   ❌ Error processing result {row_dict.get('result_id', 'unknown')}: {e}")
            skipped += 1
            skipped_reasons['parse_error'] += 1
    
    print(f"✅ Data fetch complete: {processed} examples, {skipped} skipped")
    if skipped > 0:
        print(f"   Skipped reasons: {skipped_reasons}")
    
    if processed == 0 and len(rows) > 0:
        print(f"\n⚠️  Warning: Found {len(rows)} results but none passed filters")
        print(f"   Try:")
        print(f"   - Reducing --min-score-count (currently {min_score_count})")
        print(f"   - Checking if scores are properly formatted in database")
    
    return training_data

def extract_text_from_pdf(file_path):
    """Extract text from PDF using Node.js service."""
    import subprocess
    
    # This would call the Node.js PDF extraction service
    # For now, return None and let user export via UI
    return None

def main():
    parser = argparse.ArgumentParser(description='Train local model directly from database')
    parser.add_argument('--output', default='./models/acexen-model', help='Output directory for model')
    parser.add_argument('--base-model', default='distilbert-base-uncased', 
                       help='Base model to fine-tune')
    parser.add_argument('--epochs', type=int, default=3, help='Number of training epochs')
    parser.add_argument('--batch-size', type=int, default=8, help='Batch size')
    parser.add_argument('--learning-rate', type=float, default=2e-5, help='Learning rate')
    parser.add_argument('--train-split', type=float, default=0.8, help='Train/validation split ratio')
    parser.add_argument('--max-length', type=int, default=512, help='Maximum sequence length')
    parser.add_argument('--include-text', action='store_true', default=False,
                       help='Include assignment text (requires PDF extraction)')
    parser.add_argument('--only-current', action='store_true', default=True,
                       help='Only use current versions')
    parser.add_argument('--min-score-count', type=int, default=1,
                       help='Minimum number of scores per assignment')
    parser.add_argument('--export-only', action='store_true',
                       help='Only export data, do not train')
    parser.add_argument('--export-file', help='Save exported data to JSON file')
    
    args = parser.parse_args()
    
    # Create output directory
    os.makedirs(args.output, exist_ok=True)
    
    # Check if CUDA is available
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"🖥️  Using device: {device}\n")
    
    try:
        # Connect to database
        print("🔌 Connecting to database...")
        conn = get_db_connection()
        print("✅ Database connected\n")
        
        # Quick diagnostic: check if there's any data
        print("🔍 Checking database for marking results...")
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) as count FROM marking_results")
            result = cursor.fetchone()
            total_count = result[0] if isinstance(result, (tuple, list)) else (result.get('count', 0) if isinstance(result, dict) else 0)
            print(f"   Total marking results in database: {total_count}")
            
            if total_count == 0:
                print("\n❌ No marking results found in database!")
                print("   You need to mark some assignments first.")
                print("   Steps:")
                print("   1. Upload PDFs in Acexen")
                print("   2. Create/select a rubric")
                print("   3. Mark the assignments using AI Marking")
                print("   4. Then run this training script again")
                conn.close()
                return 1
        except Exception as e:
            print(f"   ⚠️  Could not check database: {e}")
        
        # Fetch training data
        training_data = fetch_training_data(
            conn,
            include_text=args.include_text,
            only_current=args.only_current,
            min_score_count=args.min_score_count
        )
        
        if len(training_data) == 0:
            print("\n❌ No training data found after filtering!")
            print("\n   Possible reasons:")
            print("   1. All results filtered out - try reducing --min-score-count")
            print("   2. Only old versions exist - try: --only-current=False")
            print("   3. Data format issues - check if scores are properly stored")
            print("\n   Troubleshooting commands:")
            print("   - Try: --min-score-count=1 --only-current=False")
            print("   - Check: SELECT id, scores FROM marking_results LIMIT 1")
            conn.close()
            return 1
        
        # Save exported data if requested
        if args.export_file:
            print(f"\n💾 Saving exported data to {args.export_file}...")
            with open(args.export_file, 'w', encoding='utf-8') as f:
                json.dump({
                    'total_found': len(training_data),
                    'processed': len(training_data),
                    'skipped': 0,
                    'data': training_data
                }, f, indent=2, default=str)
            print(f"✅ Data saved to {args.export_file}")
        
        if args.export_only:
            print("\n✅ Export complete. Use --export-file to save data.")
            return 0
        
        # Check if we have assignment text
        has_text = any(item.get('assignment_text') for item in training_data)
        if not has_text and args.include_text:
            print("\n⚠️  Warning: No assignment text found in data!")
            print("   The model will train on rubric + scores only.")
            print("   For better results, export data via UI first (includes text extraction)")
            print("   Or use: --include-text=False to train without text")
        
        # Prepare examples
        print("\n📝 Preparing training examples...")
        examples = prepare_examples(training_data)
        
        if len(examples) < 10:
            print(f"\n❌ Not enough valid examples: {len(examples)}")
            print("   Need at least 10 examples for training.")
            print("   Try: --min-score-count=1 --only-current=False")
            return 1
        
        print(f"   Prepared {len(examples)} valid examples\n")
        
        # Train model (inline training function)
        print("🚀 Starting model training...\n")
        
        # Split data
        train_examples, eval_examples = train_test_split(
            examples,
            test_size=1 - args.train_split,
            random_state=42
        )
        
        print(f"   Training set: {len(train_examples)} examples")
        print(f"   Validation set: {len(eval_examples)} examples\n")
        
        # Create datasets
        train_dataset = Dataset.from_list(train_examples)
        eval_dataset = Dataset.from_list(eval_examples)
        
        # Load tokenizer and model
        print(f"🤖 Loading base model: {args.base_model}...")
        tokenizer = AutoTokenizer.from_pretrained(args.base_model)
        model = AutoModelForSequenceClassification.from_pretrained(
            args.base_model,
            num_labels=1,
            problem_type="regression"
        )
        
        # Tokenize datasets
        print("🔤 Tokenizing datasets...")
        def tokenize_function(examples, tokenizer, max_length=512):
            return tokenizer(
                examples['text'],
                truncation=True,
                padding='max_length',
                max_length=max_length,
                return_tensors='pt'
            )
        
        train_dataset = train_dataset.map(
            lambda x: tokenize_function(x, tokenizer, args.max_length),
            batched=True,
            remove_columns=['text']
        )
        eval_dataset = eval_dataset.map(
            lambda x: tokenize_function(x, tokenizer, args.max_length),
            batched=True,
            remove_columns=['text']
        )
        
        # Set format for PyTorch
        train_dataset.set_format('torch')
        eval_dataset.set_format('torch')
        
        # Compute metrics function
        def compute_metrics(eval_pred):
            predictions, labels = eval_pred
            predictions = np.clip(predictions, 0, 1)
            mse = mean_squared_error(labels, predictions)
            mae = mean_absolute_error(labels, predictions)
            r2 = r2_score(labels, predictions)
            return {
                'mse': mse,
                'mae': mae,
                'r2': r2,
                'rmse': np.sqrt(mse)
            }
        
        # Training arguments
        training_args = TrainingArguments(
            output_dir=args.output,
            num_train_epochs=args.epochs,
            per_device_train_batch_size=args.batch_size,
            per_device_eval_batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            weight_decay=0.01,
            logging_dir=f'{args.output}/logs',
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
        print(f"\n💾 Saving model to {args.output}...")
        trainer.save_model()
        tokenizer.save_pretrained(args.output)
        
        # Save metadata
        metadata = {
            'base_model': args.base_model,
            'training_examples': len(train_examples),
            'validation_examples': len(eval_examples),
            'epochs': args.epochs,
            'batch_size': args.batch_size,
            'learning_rate': args.learning_rate,
            'max_length': args.max_length,
            'train_loss': train_result.training_loss,
        }
        
        with open(f'{args.output}/metadata.json', 'w') as f:
            json.dump(metadata, f, indent=2)
        
        print("✅ Training complete!")
        print(f"   Model saved to: {args.output}")
        print(f"   Training loss: {train_result.training_loss:.4f}")
        
        # Evaluate
        print("\n📊 Evaluating model...")
        eval_results = trainer.evaluate()
        print(f"   Validation RMSE: {eval_results.get('eval_rmse', 'N/A'):.4f}")
        print(f"   Validation MAE: {eval_results.get('eval_mae', 'N/A'):.4f}")
        print(f"   Validation R²: {eval_results.get('eval_r2', 'N/A'):.4f}")
        
        conn.close()
        print("\n✅ Training complete!")
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    return 0

if __name__ == '__main__':
    exit(main())


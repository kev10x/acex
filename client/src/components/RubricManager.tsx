import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Edit, Trash2, Save, X } from 'lucide-react';
import { rubricsAPI, Rubric, RubricCriterion } from '../services/api';

const RubricManager: React.FC = () => {
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRubric, setEditingRubric] = useState<Rubric | null>(null);
  const [formData, setFormData] = useState({
    name: '',
    criteria: [] as RubricCriterion[],
    total_points: 0,
    rubric_type: 'rubric' as 'rubric' | 'answer_key'
  });

  useEffect(() => {
    fetchRubrics();
  }, []);

  const fetchRubrics = async () => {
    try {
      const response = await rubricsAPI.getRubrics();
      setRubrics(response.data.rubrics);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to fetch rubrics');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (editingRubric) {
        await rubricsAPI.updateRubric(editingRubric.id, formData);
        setRubrics(prev => 
          prev.map(rubric => 
            rubric.id === editingRubric.id 
              ? { ...formData, id: editingRubric.id, created_at: rubric.created_at }
              : rubric
          )
        );
      } else {
        const response = await rubricsAPI.createRubric(formData);
        setRubrics(prev => [response.data.rubric, ...prev]);
      }
      
      resetForm();
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to save rubric');
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (rubric: Rubric) => {
    setEditingRubric(rubric);
    setFormData({
      name: rubric.name,
      criteria: rubric.criteria,
      total_points: rubric.total_points,
      rubric_type: rubric.rubric_type || 'rubric'
    });
    setShowForm(true);
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Are you sure you want to delete this rubric?')) return;

    try {
      await rubricsAPI.deleteRubric(id);
      setRubrics(prev => prev.filter(rubric => rubric.id !== id));
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to delete rubric');
    }
  };

  const resetForm = () => {
    setFormData({
      name: '',
      criteria: [],
      total_points: 0,
      rubric_type: 'rubric'
    });
    setEditingRubric(null);
    setShowForm(false);
  };

  const addCriterion = () => {
    setFormData(prev => ({
      ...prev,
      criteria: [...prev.criteria, { name: '', max_points: 0, description: '' }]
    }));
  };

  const updateCriterion = (index: number, field: keyof RubricCriterion, value: string | number) => {
    setFormData(prev => ({
      ...prev,
      criteria: prev.criteria.map((criterion, i) => 
        i === index ? { ...criterion, [field]: value } : criterion
      )
    }));
  };

  const removeCriterion = (index: number) => {
    setFormData(prev => ({
      ...prev,
      criteria: prev.criteria.filter((_, i) => i !== index)
    }));
  };

  const calculateTotalPoints = useCallback(() => {
    return formData.criteria.reduce((sum, criterion) => sum + criterion.max_points, 0);
  }, [formData.criteria]);

  useEffect(() => {
    setFormData(prev => ({
      ...prev,
      total_points: calculateTotalPoints()
    }));
  }, [calculateTotalPoints]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Manage Rubrics</h2>
          <p className="mt-1 text-sm text-gray-600">
            Create and manage marking rubrics for your assignments.
          </p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
        >
          <Plus className="w-4 h-4 mr-2" />
          New Rubric
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">Error</h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Rubric Form */}
      {showForm && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">
                {editingRubric ? 'Edit Rubric' : 'Create New Rubric'}
              </h3>
              <button
                onClick={resetForm}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700">
                  Rubric Name
                </label>
                <input
                  type="text"
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  required
                />
              </div>

              <div>
                <label htmlFor="rubricType" className="block text-sm font-medium text-gray-700">
                  Rubric Type
                </label>
                <select
                  id="rubricType"
                  value={formData.rubric_type}
                  onChange={(e) => setFormData(prev => ({ ...prev, rubric_type: e.target.value as 'rubric' | 'answer_key' }))}
                  className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                >
                  <option value="rubric">Regular Rubric</option>
                  <option value="answer_key">Answer Key / Memo</option>
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  {formData.rubric_type === 'rubric'
                    ? 'Use for standard marking rubrics with performance criteria.'
                    : 'Use for memos/answer keys with model answers; will be treated as a memo during marking.'}
                </p>
              </div>

              <div>
                <div className="flex justify-between items-center mb-3">
                  <label className="block text-sm font-medium text-gray-700">
                    Criteria
                  </label>
                  <button
                    type="button"
                    onClick={addCriterion}
                    className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-xs font-medium rounded text-gray-700 bg-white hover:bg-gray-50"
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Criterion
                  </button>
                </div>

                <div className="space-y-4">
                  {formData.criteria.map((criterion, index) => (
                    <div key={index} className="border border-gray-200 rounded-lg p-4">
                      <div className="flex justify-between items-start mb-3">
                        <h4 className="text-sm font-medium text-gray-700">
                          Criterion {index + 1}
                        </h4>
                        <button
                          type="button"
                          onClick={() => removeCriterion(index)}
                          className="text-red-400 hover:text-red-600"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            Name
                          </label>
                          <input
                            type="text"
                            value={criterion.name}
                            onChange={(e) => updateCriterion(index, 'name', e.target.value)}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            Max Points
                          </label>
                          <input
                            type="number"
                            min="0"
                            value={criterion.max_points}
                            onChange={(e) => updateCriterion(index, 'max_points', parseInt(e.target.value) || 0)}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-700">
                            Description
                          </label>
                          <textarea
                            value={criterion.description}
                            onChange={(e) => updateCriterion(index, 'description', e.target.value)}
                            rows={2}
                            className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                            required
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-gray-50 px-4 py-3 rounded-md">
                <div className="flex justify-between items-center">
                  <span className="text-sm font-medium text-gray-700">
                    Total Points: {formData.total_points}
                  </span>
                  <div className="flex space-x-3">
                    <button
                      type="button"
                      onClick={resetForm}
                      className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={loading || formData.criteria.length === 0}
                      className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50"
                    >
                      <Save className="w-4 h-4 mr-2" />
                      {loading ? 'Saving...' : editingRubric ? 'Update' : 'Create'}
                    </button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rubrics List */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-4 py-5 sm:p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4">
            Saved Rubrics ({rubrics.length})
          </h3>
          
          {rubrics.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500">No rubrics created yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Create your first rubric to get started.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {rubrics.map((rubric, index) => (
                <div key={rubric.id || `rubric-${index}`} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <h4 className="text-lg font-medium text-gray-900">
                        {rubric.name}
                      </h4>
                      <div className="mt-1 flex items-center space-x-2">
                        <p className="text-sm text-gray-500">
                          {rubric.criteria.length} criteria • {rubric.total_points} total points
                        </p>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                            rubric.rubric_type === 'answer_key'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {rubric.rubric_type === 'answer_key' ? 'Answer Key / Memo' : 'Rubric'}
                        </span>
                      </div>
                      <div className="mt-3 space-y-2">
                        {rubric.criteria.map((criterion, index) => (
                          <div key={`${rubric.id}-criterion-${index}`} className="flex justify-between items-center text-sm">
                            <span className="text-gray-700">{criterion.name}</span>
                            <span className="text-gray-500">{criterion.max_points} points</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="flex space-x-2 ml-4">
                      <button
                        onClick={() => handleEdit(rubric)}
                        className="text-primary-600 hover:text-primary-900"
                      >
                        <Edit className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(rubric.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default RubricManager;

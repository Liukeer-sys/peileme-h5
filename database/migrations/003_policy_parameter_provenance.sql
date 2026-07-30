ALTER TABLE policy_calculation_snapshots
  ADD COLUMN parameter_provenance JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE policy_calculation_snapshots snapshot
   SET parameter_provenance = CASE
     WHEN jsonb_typeof(assessment.answers) = 'object'
      AND jsonb_typeof(
        assessment.answers->'parameterProvenance'
      ) = 'object'
       THEN assessment.answers->'parameterProvenance'
     ELSE '{}'::jsonb
   END
  FROM assessments assessment
 WHERE assessment.id = snapshot.assessment_id;

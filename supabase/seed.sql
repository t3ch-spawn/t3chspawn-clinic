-- Demo clinic hours in Africa/Lagos; rolling future weekdays, safe to rerun.
INSERT INTO public.slots (clinician, starts_at, ends_at)
SELECT 'Dr. Ada Okafor', local_start AT TIME ZONE 'Africa/Lagos',
       (local_start + interval '30 minutes') AT TIME ZONE 'Africa/Lagos'
FROM (
  SELECT ((now() AT TIME ZONE 'Africa/Lagos')::date + day + hour * interval '1 hour') AS local_start
  FROM generate_series(1, 7) day CROSS JOIN generate_series(9, 15) hour
) dates
WHERE extract(isodow FROM local_start) BETWEEN 1 AND 5
AND NOT EXISTS (
  SELECT 1 FROM public.slots WHERE clinician = 'Dr. Ada Okafor'
  AND starts_at = local_start AT TIME ZONE 'Africa/Lagos'
);

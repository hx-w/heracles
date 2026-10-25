package app

import _ "embed"

//go:embed assets/exercises.json
var exerciseData []byte

func LoadExercises() []M {
	out := []M{}
	for _, v := range array(decode(exerciseData)) {
		out = append(out, object(v))
	}
	return out
}
func (s *Server) Exercise(identifier string) M {
	for _, e := range s.Exercises {
		if str(e["id"]) == identifier {
			return e
		}
	}
	return nil
}
func (s *Server) HasExercise(identifier string) bool { return s.Exercise(identifier) != nil }
